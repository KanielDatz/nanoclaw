/**
 * Chromium trust for the gateway's TLS-interception CA.
 *
 * The gateway MITMs every outbound HTTPS request to inject credentials, so the
 * certificate a client sees is signed by the gateway's own CA. The gateway's
 * container config teaches the usual clients to trust it by pointing them at a
 * PEM (`NODE_EXTRA_CA_CERTS`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`,
 * `SSL_CERT_FILE`, `GIT_SSL_CAINFO`). Chromium honors none of those — it keeps
 * its own trust store — so `agent-browser` (Playwright + /usr/bin/chromium),
 * which picks the proxy up from `HTTPS_PROXY` like everything else, failed
 * every navigation with `net::ERR_CERT_AUTHORITY_INVALID`.
 *
 * The obvious-looking alternative — let the browser skip the proxy and reach
 * the internet directly — is not available: agent containers sit on a Docker
 * `--internal` network (`src/egress-lockdown.ts`) whose only route off-box is
 * the gateway. Direct egress does not exist per-process; it would have to be
 * granted to the whole container, which is the perimeter itself. And a blanket
 * `--ignore-https-errors` would trade a cert error for no cert checking at all.
 *
 * So the trust anchor is handed to Chromium the way Chromium takes one: a
 * managed-policy file (`CACertificates`, Chrome 131+) mounted read-only into
 * `/etc/chromium/policies/managed/`. Browser traffic keeps flowing through the
 * gateway — credential injection, rules and audit unchanged — and Chromium
 * trusts exactly the same single CA curl and Node already trust, nothing more.
 *
 * The policy file is written under `data/` rather than the OS temp dir on
 * purpose: on a VM-backed Docker (Colima, the shipped macOS setup) the host's
 * `$TMPDIR` is not shared into the VM, so a bind mount whose source lives there
 * silently materializes as an empty directory inside the container.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import type { MountSpec } from '../drivers/types.js';
import { log } from '../log.js';

import type { GatewayContribution } from './gateway-provider-registry.js';

/** Where Chromium reads machine-wide managed policy inside the agent image. */
export const CHROMIUM_POLICY_CONTAINER_PATH = '/etc/chromium/policies/managed/nanoclaw-gateway-ca.json';

/** Host directory holding the generated per-group policy files. */
export const CHROMIUM_POLICY_HOST_DIR = path.join(DATA_DIR, 'gateway-trust');

/**
 * A gateway CA is one certificate, occasionally a short chain. A PEM with more
 * than this is a system bundle (the SDK also ships `/tmp/onecli-combined-ca.pem`,
 * the OS store plus the gateway CA) — handing Chromium hundreds of anchors it
 * already has, from a file we did not curate, is not what this is for. Refuse
 * and leave Chromium's trust store untouched.
 */
const MAX_TRUST_ANCHORS = 4;

const CERT_BLOCK = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;

/**
 * PEM → the `CACertificates` policy document Chromium expects (base64 DER per
 * certificate, i.e. the PEM body with its armor and whitespace stripped).
 *
 * Returns null when the PEM holds no certificate, or more than a gateway CA
 * plausibly is.
 */
export function chromiumCaPolicyFromPem(pem: string): string | null {
  const certs = [...pem.matchAll(CERT_BLOCK)]
    .map((match) => match[1].replace(/\s+/g, ''))
    .filter((body) => body.length > 0);
  if (certs.length === 0 || certs.length > MAX_TRUST_ANCHORS) return null;
  return `${JSON.stringify({ CACertificates: certs }, null, 2)}\n`;
}

/** Group ids are opaque; keep them to something safe to spell as a filename. */
function policyFileName(agentGroupId: string): string {
  return `${agentGroupId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

/**
 * Which mount carries the gateway CA.
 *
 * `NODE_EXTRA_CA_CERTS` is the contribution's own statement of where the CA
 * lands in the container, so the mount whose target it names is the CA mount —
 * no guessing by filename, and the combined OS bundle (a different target) is
 * never mistaken for it.
 */
export function gatewayCaMount(contribution: GatewayContribution): MountSpec | null {
  const caPath = contribution.env?.NODE_EXTRA_CA_CERTS;
  if (!caPath) return null;
  return contribution.mounts?.find((mount) => mount.containerPath === caPath) ?? null;
}

/**
 * Add the Chromium trust-anchor mount to a gateway contribution.
 *
 * Best-effort by design: a gateway that ships no CA mount, an unreadable PEM or
 * a bundle-shaped one leaves the contribution exactly as it was. Chromium then
 * fails the way it does today — which is strictly better than failing the spawn
 * of an otherwise healthy session over a browser convenience.
 */
export function withChromiumGatewayTrust(
  contribution: GatewayContribution,
  agentGroupId: string,
  hostDir: string = CHROMIUM_POLICY_HOST_DIR,
): GatewayContribution {
  const caMount = gatewayCaMount(contribution);
  if (!caMount) return contribution;

  let policy: string | null;
  try {
    policy = chromiumCaPolicyFromPem(fs.readFileSync(caMount.hostPath, 'utf-8'));
  } catch (error) {
    log.warn('Gateway CA unreadable — Chromium keeps its own trust store', {
      hostPath: caMount.hostPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return contribution;
  }
  if (!policy) {
    log.warn('Gateway CA PEM is not a single trust anchor — skipping Chromium policy', {
      hostPath: caMount.hostPath,
    });
    return contribution;
  }

  const hostPath = path.join(hostDir, policyFileName(agentGroupId));
  try {
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(hostPath, policy, { mode: 0o644 });
  } catch (error) {
    log.warn('Could not write the Chromium gateway-trust policy', {
      hostPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return contribution;
  }

  return {
    ...contribution,
    mounts: [
      ...(contribution.mounts ?? []),
      {
        class: 'allowlisted-extra',
        hostPath,
        containerPath: CHROMIUM_POLICY_CONTAINER_PATH,
        mode: 'ro',
        groupScope: agentGroupId,
      },
    ],
  };
}
