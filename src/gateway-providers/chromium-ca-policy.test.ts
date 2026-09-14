import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../config.js', () => ({ DATA_DIR: '/install/data' }));

import type { GatewayContribution } from './gateway-provider-registry.js';

import {
  CHROMIUM_POLICY_CONTAINER_PATH,
  chromiumCaPolicyFromPem,
  gatewayCaMount,
  withChromiumGatewayTrust,
} from './chromium-ca-policy.js';

function pem(body: string): string {
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

const CA_BODY = 'MIIBcertbytesAAAA\nBBBBccccDDDD';

describe('chromiumCaPolicyFromPem', () => {
  it('emits base64 DER per certificate, armor and line breaks stripped', () => {
    const policy = chromiumCaPolicyFromPem(pem(CA_BODY));
    expect(policy).not.toBeNull();
    expect(JSON.parse(policy!)).toEqual({ CACertificates: ['MIIBcertbytesAAAABBBBccccDDDD'] });
  });

  it('carries a short chain whole', () => {
    const policy = chromiumCaPolicyFromPem(`${pem('AAAA')}${pem('BBBB')}`);
    expect(JSON.parse(policy!)).toEqual({ CACertificates: ['AAAA', 'BBBB'] });
  });

  it('refuses a PEM with no certificate', () => {
    expect(chromiumCaPolicyFromPem('')).toBeNull();
    expect(chromiumCaPolicyFromPem('-----BEGIN CERTIFICATE-----\n\n-----END CERTIFICATE-----\n')).toBeNull();
  });

  it('refuses a system bundle — Chromium gets a curated anchor or none', () => {
    const bundle = Array.from({ length: 12 }, (_, i) => pem(`cert${i}`)).join('');
    expect(chromiumCaPolicyFromPem(bundle)).toBeNull();
  });
});

describe('gatewayCaMount', () => {
  const caMount = {
    class: 'allowlisted-extra' as const,
    hostPath: '/tmp/onecli-proxy-ca.pem',
    containerPath: '/tmp/onecli-gateway-ca.pem',
    mode: 'ro' as const,
    groupScope: 'g1',
  };
  const bundleMount = { ...caMount, hostPath: '/tmp/combined.pem', containerPath: '/tmp/onecli-combined-ca.pem' };

  it('picks the mount NODE_EXTRA_CA_CERTS names, not the combined OS bundle', () => {
    const contribution: GatewayContribution = {
      env: { NODE_EXTRA_CA_CERTS: '/tmp/onecli-gateway-ca.pem', SSL_CERT_FILE: '/tmp/onecli-combined-ca.pem' },
      mounts: [bundleMount, caMount],
    };
    expect(gatewayCaMount(contribution)).toBe(caMount);
  });

  it('is null when the gateway names no CA', () => {
    expect(gatewayCaMount({ env: {}, mounts: [bundleMount] })).toBeNull();
  });
});

describe('withChromiumGatewayTrust', () => {
  let hostDir: string;
  let caPath: string;

  beforeEach(() => {
    hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-chromium-trust-'));
    caPath = path.join(hostDir, 'source-ca.pem');
    fs.writeFileSync(caPath, pem(CA_BODY));
  });

  afterEach(() => {
    fs.rmSync(hostDir, { recursive: true, force: true });
  });

  function contributionWithCa(): GatewayContribution {
    return {
      env: { HTTPS_PROXY: 'http://gateway:10255', NODE_EXTRA_CA_CERTS: '/tmp/onecli-gateway-ca.pem' },
      mounts: [
        {
          class: 'allowlisted-extra',
          hostPath: caPath,
          containerPath: '/tmp/onecli-gateway-ca.pem',
          mode: 'ro',
          groupScope: 'g1',
        },
      ],
    };
  }

  it('adds a read-only managed-policy mount built from the gateway CA', () => {
    const out = withChromiumGatewayTrust(contributionWithCa(), 'ag-1', path.join(hostDir, 'out'));

    // The proxy env is untouched: browser traffic still goes through the gateway.
    expect(out.env).toEqual(contributionWithCa().env);
    expect(out.mounts).toHaveLength(2);
    const policyMount = out.mounts!.at(-1)!;
    expect(policyMount).toMatchObject({
      class: 'allowlisted-extra',
      containerPath: CHROMIUM_POLICY_CONTAINER_PATH,
      mode: 'ro',
      groupScope: 'ag-1',
    });
    expect(JSON.parse(fs.readFileSync(policyMount.hostPath, 'utf-8'))).toEqual({
      CACertificates: ['MIIBcertbytesAAAABBBBccccDDDD'],
    });
  });

  it('keeps the group id out of the filesystem verbatim when it is not filename-safe', () => {
    const out = withChromiumGatewayTrust(contributionWithCa(), 'ag/../evil', path.join(hostDir, 'out'));
    expect(path.dirname(out.mounts!.at(-1)!.hostPath)).toBe(path.join(hostDir, 'out'));
  });

  it('leaves the contribution alone when the gateway ships no CA mount', () => {
    const bare: GatewayContribution = { env: { HTTPS_PROXY: 'http://gateway:10255' }, mounts: [] };
    expect(withChromiumGatewayTrust(bare, 'ag-1', path.join(hostDir, 'out'))).toBe(bare);
  });

  it('leaves the contribution alone when the CA file cannot be read', () => {
    const contribution = contributionWithCa();
    fs.rmSync(caPath);
    expect(withChromiumGatewayTrust(contribution, 'ag-1', path.join(hostDir, 'out'))).toBe(contribution);
  });

  it('leaves the contribution alone when the CA file is a bundle', () => {
    fs.writeFileSync(caPath, Array.from({ length: 12 }, (_, i) => pem(`cert${i}`)).join(''));
    const contribution = contributionWithCa();
    expect(withChromiumGatewayTrust(contribution, 'ag-1', path.join(hostDir, 'out'))).toBe(contribution);
  });
});
