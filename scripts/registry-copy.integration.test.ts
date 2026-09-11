import { execFileSync, execSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadProvisioningCore, PROVISIONING_MODULE, type ProvisioningCore } from '../setup/channels/slack-auto.js';
import { applySkill, fullyApplied } from './skill-apply.js';

// Real Git repositories and shell commands reproduce failed registry copies.
// Only the Slack import and GitHub dependency/build commands are substitutes;
// no network, platform accounts, or agent credentials are used here.
vi.mock('../setup/logs.js', () => ({ step: vi.fn() }));

let sandbox: string;
let registry: string;
let root: string;
let skill: string;
let env: NodeJS.ProcessEnv;
const payload = 'export const installed = true;\n';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function put(base: string, file: string, body: string): void {
  mkdirSync(dirname(join(base, file)), { recursive: true });
  writeFileSync(join(base, file), body);
}

function publish(file: string, body = payload): void {
  git(registry, 'checkout', 'channels');
  put(registry, file, body);
  git(registry, 'add', '.');
  git(registry, 'commit', '-qm', 'Update registry fixture');
  git(registry, 'checkout', 'main');
}

function exec(command: string): string {
  return execSync(command, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function copySkill(source: string, destination: string): void {
  put(skill, 'SKILL.md', `# Copy fixture\n\n\`\`\`nc:copy from-branch:channels\n${source} -> ${destination}\n\`\`\`\n`);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'nc-registry-copy-'));
  registry = join(sandbox, 'registry');
  root = join(sandbox, 'install');
  skill = join(sandbox, 'skill');
  // Ignore operator Git hooks, signing, and URL rewrites in disposable fixtures.
  env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Copy test',
    GIT_AUTHOR_EMAIL: 'copy@example.invalid',
    GIT_COMMITTER_NAME: 'Copy test',
    GIT_COMMITTER_EMAIL: 'copy@example.invalid',
  };
  delete env.NANOCLAW_CHANNELS_REMOTE;
  mkdirSync(registry);
  git(registry, 'init', '-b', 'main');
  put(registry, 'package.json', '{"name":"copy-fixture"}\n');
  put(registry, 'src/channels/index.ts', '// channel registrations\n');
  git(registry, 'add', '.');
  git(registry, 'commit', '-qm', 'Initial fixture');
  git(registry, 'branch', 'channels');
  publish('payload.ts');
  git(sandbox, 'clone', '--no-local', registry, root);
});

afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

describe('registry copy failures and retries', () => {
  it.each([false, true])('preserves a skill destination on failure (existing=%s), then retries', async (existing) => {
    const destination = 'src/copied.ts';
    if (existing) {
      put(root, destination, 'local content\n');
      chmodSync(join(root, destination), 0o755);
    }
    copySkill('missing.ts', destination);
    const options = { exec, resolveRemote: () => 'origin', mode: 'refresh' as const };
    const failed = await applySkill(skill, root, options);
    expect(fullyApplied(failed)).toBe(false);
    expect(failed.journal).toEqual([]);
    if (existing) expect(readFileSync(join(root, destination), 'utf8')).toBe('local content\n');
    else expect(existsSync(join(root, destination))).toBe(false);
    expect(readdirSync(join(root, 'src')).sort()).toEqual(existing ? ['channels', 'copied.ts'] : ['channels']);

    copySkill('payload.ts', destination);
    const retried = await applySkill(skill, root, options);
    expect(fullyApplied(retried)).toBe(true);
    expect(readFileSync(join(root, destination), 'utf8')).toBe(payload);
    // A new file follows the normal umask, so mounted source remains readable.
    const expectedMode = existing ? 0o755 : statSync(join(root, 'src/channels/index.ts')).mode & 0o777;
    expect(statSync(join(root, destination)).mode & 0o777).toBe(expectedMode);
  });

  it.each([false, true])('discards partial producer output on failure (existing=%s)', async (existing) => {
    const destination = 'src/copied.ts';
    if (existing) put(root, destination, 'keep me\n');
    copySkill('payload.ts', destination);
    const failed = await applySkill(skill, root, {
      mode: 'refresh',
      resolveRemote: () => 'origin',
      exec: (command) =>
        exec(command.includes('git show ') ? `git() { printf partial; return 23; }\n${command}` : command),
    });
    expect(fullyApplied(failed)).toBe(false);
    if (existing) expect(readFileSync(join(root, destination), 'utf8')).toBe('keep me\n');
    else expect(existsSync(join(root, destination))).toBe(false);
    expect(readdirSync(join(root, 'src')).sort()).toEqual(existing ? ['channels', 'copied.ts'] : ['channels']);
  });

  it('copies literal paths containing spaces, quotes, and shell substitutions', async () => {
    const source = "payload '$(touch injected).ts";
    const destination = "src/copied '$(touch injected).ts";
    publish(source);
    copySkill(source, destination);
    const result = await applySkill(skill, root, { exec, resolveRemote: () => 'origin' });
    expect(fullyApplied(result)).toBe(true);
    expect(readFileSync(join(root, destination), 'utf8')).toBe(payload);
    expect(existsSync(join(root, 'injected'))).toBe(false);
  });

  it('does not poison install-mode retry when the remote-tracking ref is absent', async () => {
    git(root, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
    git(root, 'update-ref', '-d', 'refs/remotes/origin/channels');
    copySkill('payload.ts', 'src/copied.ts');
    const options = { exec, resolveRemote: () => 'origin' };
    const failed = await applySkill(skill, root, options);
    expect(fullyApplied(failed)).toBe(false);
    expect(existsSync(join(root, 'src/copied.ts'))).toBe(false);
    // Repair the separate CORE-04 prerequisite, then retry without file cleanup.
    git(root, 'fetch', 'origin', 'channels:refs/remotes/origin/channels');
    expect(fullyApplied(await applySkill(skill, root, options))).toBe(true);
    expect(readFileSync(join(root, 'src/copied.ts'), 'utf8')).toBe(payload);
  });

  it('retries Slack provisioning after a missing registry file without importing a placeholder', async () => {
    const core = {} as ProvisioningCore;
    const importModule = vi.fn(async () => core);
    expect(await loadProvisioningCore({ root, exec, importModule })).toBeUndefined();
    expect(importModule).not.toHaveBeenCalled();
    expect(existsSync(join(root, PROVISIONING_MODULE))).toBe(false);
    expect(readdirSync(join(root, 'src/provisioning'))).toEqual([]);

    publish(PROVISIONING_MODULE);
    expect(await loadProvisioningCore({ root, exec, importModule })).toBe(core);
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(root, PROVISIONING_MODULE), 'utf8')).toBe(payload);
  });

  it.each([false, true])('preserves the GitHub adapter on failure (existing=%s), then retries', (existing) => {
    mkdirSync(join(root, 'setup'));
    copyFileSync(new URL('../setup/install-github.sh', import.meta.url), join(root, 'setup/install-github.sh'));
    const adapter = 'src/channels/github.ts';
    if (existing) {
      put(root, adapter, 'local adapter\n');
      chmodSync(join(root, adapter), 0o755);
    }
    put(root, 'test-bin/pnpm', '#!/bin/sh\nprintf "%s\\n" "$*" >> pnpm-called\n');
    chmodSync(join(root, 'test-bin/pnpm'), 0o755);
    const run = () =>
      spawnSync('bash', ['setup/install-github.sh'], {
        cwd: root,
        env: { ...env, PATH: `${join(root, 'test-bin')}:${env.PATH}` },
        encoding: 'utf8',
      });
    const failed = run();
    expect(failed.status).not.toBe(0);
    if (existing) expect(readFileSync(join(root, adapter), 'utf8')).toBe('local adapter\n');
    else expect(existsSync(join(root, adapter))).toBe(false);
    expect(readdirSync(join(root, 'src/channels')).sort()).toEqual(existing ? ['github.ts', 'index.ts'] : ['index.ts']);
    expect(readFileSync(join(root, 'src/channels/index.ts'), 'utf8')).not.toContain("import './github.js'");
    expect(existsSync(join(root, 'pnpm-called'))).toBe(false);

    publish(adapter);
    expect(run().status).toBe(0);
    expect(readFileSync(join(root, adapter), 'utf8')).toBe(payload);
    expect(statSync(join(root, adapter)).mode & 0o777).toBe(
      existing ? 0o755 : statSync(join(root, 'src/channels/index.ts')).mode & 0o777,
    );
    expect(readFileSync(join(root, 'src/channels/index.ts'), 'utf8')).toContain("import './github.js'");
    expect(readFileSync(join(root, 'pnpm-called'), 'utf8')).toContain('run build');
  });
});
