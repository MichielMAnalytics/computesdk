import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthenticationError,
  BoxdError,
  ConflictError,
  MachineFileExistsError,
  MachineFileNotFoundError,
  NotFoundError,
} from '@boxd-sh/sdk';
import { boxd } from '../index';

const clientOptions: Array<Record<string, unknown>> = [];
const m = {
  create: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  waitUntilReady: vi.fn(),
  exec: vi.fn(),
  streamExec: vi.fn(),
};
const proxies = { list: vi.fn(), create: vi.fn() };
const fs = { read: vi.fn(), write: vi.fn(), mkdir: vi.fn(), stat: vi.fn(), list: vi.fn(), exists: vi.fn(), remove: vi.fn() };
const snapshots = { create: vi.fn(), get: vi.fn(), list: vi.fn(), delete: vi.fn() };
const disks = { create: vi.fn(), list: vi.fn(), attach: vi.fn(), detach: vi.fn(), delete: vi.fn() };

vi.mock('@boxd-sh/sdk', () => {
  class BoxdError extends Error {
    constructor(message: string, readonly grpcCode?: number) {
      super(message);
    }
  }
  class NotFoundError extends BoxdError {}
  class ConflictError extends BoxdError {}
  class AuthenticationError extends BoxdError {}
  class FilesystemError extends BoxdError {}
  class MachineFileNotFoundError extends FilesystemError {}
  class MachineFileExistsError extends FilesystemError {}
  class Boxd {
    readonly machines = { ...m, proxies, fs };
    readonly snapshots = snapshots;
    readonly disks = disks;
    constructor(options: Record<string, unknown>) {
      clientOptions.push(options);
    }
  }
  return { Boxd, BoxdError, NotFoundError, ConflictError, AuthenticationError, MachineFileNotFoundError, MachineFileExistsError };
});

// Every computer gets its own id, so what the provider remembers about one never leaks into another test.
let seq = 0;
function machine(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `m-${seq}`,
    name: `computesdk-test-${seq}`,
    status: 'running',
    createdAt: new Date('2026-11-04T10:00:00Z'),
    region: 'fra',
    resources: { vcpu: 2 },
    org: { name: 'acme' },
    labels: { computesdk: 'true' },
    deleteAt: null,
    bootTimeMs: 6,
    ...overrides,
  };
}

function disk(overrides: Record<string, unknown> = {}) {
  return { id: 'd-1', name: 'cache', sizeBytes: 1024 ** 3, status: 'ready', createdAt: new Date(0), attachments: [], region: 'fra', ...overrides };
}

/** A listing across regions, as the SDK returns it. */
const regional = <T>(items: T[], unavailable: string[] = []) => Object.assign([...items], { elsewhere: [], unavailable });

/** An exec stream that plays the given chunks, then exits, hangs until closed, fails, or never ends. */
function fakeStream(opts: { stdout?: string[]; stderr?: string[]; exitCode?: number; hang?: boolean; fail?: Error; failAfterMs?: number; never?: boolean }) {
  const enc = new TextEncoder();
  let release!: () => void;
  const closed = new Promise<void>((resolve) => (release = resolve));
  const cancelled = () => new BoxdError('Cancelled on client', 1);
  async function* play(chunks: string[] = []) {
    for (const chunk of chunks) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      yield enc.encode(chunk);
    }
    if (opts.never) await new Promise(() => {});
    if (opts.hang) {
      await closed;
      throw cancelled();
    }
  }
  const wait = (): Promise<number> => {
    if (opts.never) return new Promise(() => {});
    if (opts.fail) return new Promise((_, reject) => setTimeout(() => reject(opts.fail), opts.failAfterMs ?? 0));
    if (opts.hang) return closed.then(() => Promise.reject(cancelled()));
    return new Promise((resolve) => setTimeout(() => resolve(opts.exitCode ?? 0), 5));
  };
  return { stdout: play(opts.stdout), stderr: play(opts.stderr), wait, close: vi.fn(() => release()) };
}

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0, success: true });
const ready = () => new Response(null, { status: 204, headers: { 'x-boxd-proxy': 'ready' } });
const notFound = () => new NotFoundError('VM not found (region fra)', 5);
const stopped = (name = 'computesdk-test') => new ConflictError(`VM ${name} is stopped, so it won't be resumed automatically`, 9);

const provider = (config: Record<string, unknown> = {}) => boxd({ apiKey: 'bxd_test', org: 'acme', ...config });

async function created(options: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  const mach = machine(overrides);
  m.create.mockResolvedValueOnce(mach);
  m.waitUntilReady.mockResolvedValueOnce(mach);
  const sandbox = await provider(config).instances.create(options);
  return { sandbox, id: mach.id, mach };
}

beforeEach(() => {
  const all = [...Object.values(m), ...Object.values(proxies), ...Object.values(fs), ...Object.values(snapshots), ...Object.values(disks)];
  for (const fn of all) fn.mockReset();
  // A shell's own boxd settings must not leak into these tests.
  for (const name of ['BOXD_API_KEY', 'BOXD_TOKEN', 'BOXD_ORG', 'BOXD_REGION', 'BOXD_BASE_URL']) vi.stubEnv(name, '');
  vi.stubGlobal('fetch', vi.fn(async () => ready()));
  m.list.mockResolvedValue(regional([]));
  m.stop.mockResolvedValue(undefined);
  m.delete.mockResolvedValue(undefined);
  disks.list.mockResolvedValue(regional([]));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('config', () => {
  it('throws a helpful error without credentials', async () => {
    await expect(boxd({}).instances.create()).rejects.toThrow(/BOXD_API_KEY/);
    expect(m.create).not.toHaveBeenCalled();
  });

  it('reads the key, org and region from the environment', async () => {
    vi.stubEnv('BOXD_API_KEY', 'bxd_env');
    vi.stubEnv('BOXD_ORG', 'env-org');
    vi.stubEnv('BOXD_REGION', 'nyc');
    m.create.mockResolvedValueOnce(machine({ region: 'nyc' }));
    m.waitUntilReady.mockResolvedValueOnce(machine({ region: 'nyc' }));
    await boxd({}).instances.create();
    expect(clientOptions.at(-1)).toMatchObject({ apiKey: 'bxd_env', region: 'nyc' });
    expect(m.create.mock.calls[0][0]).toMatchObject({ org: 'env-org', region: 'nyc' });
  });

  it('uses a key passed in over a BOXD_TOKEN in the environment', async () => {
    vi.stubEnv('BOXD_TOKEN', 'env-token');
    await created({}, {}, { apiKey: 'bxd_explicit' });
    expect(clientOptions.at(-1)).toMatchObject({ apiKey: 'bxd_explicit' });
    expect(clientOptions.at(-1)).not.toHaveProperty('token');
  });

  it('prefers BOXD_TOKEN over BOXD_API_KEY, as the SDK does', async () => {
    vi.stubEnv('BOXD_API_KEY', 'bxd_env_2');
    vi.stubEnv('BOXD_TOKEN', 'env-token-2');
    m.create.mockResolvedValueOnce(machine());
    m.waitUntilReady.mockResolvedValueOnce(machine());
    await boxd({}).instances.create();
    expect(clientOptions.at(-1)).toMatchObject({ token: 'env-token-2' });
    expect(clientOptions.at(-1)).not.toHaveProperty('apiKey');
  });

  it('takes timeout as the default lifetime and requestTimeout as the API deadline', async () => {
    await created({}, {}, { apiKey: 'bxd_lifetime', timeout: 60_000, requestTimeout: 5000 });
    expect(m.create.mock.calls[0][0].deleteAfter).toBe(60);
    expect(clientOptions.at(-1)).toMatchObject({ apiKey: 'bxd_lifetime', timeout: 5000 });
  });
});

describe('create', () => {
  it('creates an isolated, labelled computer and waits until it is ready', async () => {
    const { sandbox, id } = await created();
    const params = m.create.mock.calls[0][0];
    expect(params).toMatchObject({ org: 'acme', isolated: true, labels: { computesdk: 'true' } });
    expect(params.name).toMatch(/^computesdk-[0-9a-f]{8}$/);
    expect(m.waitUntilReady).toHaveBeenCalledWith(id, { region: 'fra' });
    expect(sandbox.instanceId).toBe(id);
    expect(sandbox.provider).toBe('boxd');
  });

  it('maps timeout to a delete-after timer in seconds', async () => {
    await created({ timeout: 90_500 });
    expect(m.create.mock.calls[0][0].deleteAfter).toBe(91);
  });

  it('maps vcpus or memory onto a boxd size', async () => {
    await created({ vcpus: 4 });
    expect(m.create.mock.calls[0][0].config).toEqual({ vcpu: 4, memory: '16G' });
    await created({ memoryMiB: 8192 });
    expect(m.create.mock.calls[1][0].config).toEqual({ vcpu: 2, memory: '8G' });
  });

  it('refuses a size boxd does not have', async () => {
    await expect(provider().instances.create({ vcpus: 2, memoryMiB: 4096 })).rejects.toThrow(/1 vCPU \/ 4 GiB, 2 vCPU \/ 8 GiB/);
    expect(m.create).not.toHaveBeenCalled();
  });

  it('creates from a snapshot, and refuses a size with one', async () => {
    await created({ snapshotId: 'snap-1' });
    expect(m.create.mock.calls[0][0]).toMatchObject({ fromSnapshot: 'snap-1', isolated: true });
    await expect(provider().instances.create({ snapshotId: 'snap-1', vcpus: 2 })).rejects.toThrow(/keeps the snapshot's size/);
  });

  it('refuses an image', async () => {
    await expect(provider().instances.create({ image: 'node:22' })).rejects.toThrow(/snapshotId/);
  });

  it('stores metadata as labels with boxd-shaped keys', async () => {
    await created({ metadata: { userId: 'u-1', 'Team Name': 'A', count: 3, nested: { a: 1 }, skipped: undefined } });
    expect(m.create.mock.calls[0][0].labels).toEqual({
      userid: 'u-1',
      'team-name': 'A',
      count: '3',
      nested: '{"a":1}',
      computesdk: 'true',
    });
  });

  it('refuses a metadata key boxd reserves', async () => {
    await expect(provider().instances.create({ metadata: { 'boxd/login': 'x' } })).rejects.toThrow(/reserved/);
    expect(m.create).not.toHaveBeenCalled();
  });

  it('names a route for each port in create({ ports })', async () => {
    await created({ ports: [3000, 8080] });
    expect(m.create.mock.calls[0][0].config).toEqual({ proxies: [{ name: 'p3000', port: 3000 }, { name: 'p8080', port: 8080 }] });
    await expect(provider().instances.create({ ports: [70000] })).rejects.toThrow(/1 to 65535/);
  });

  it('passes autoSuspendTimeout and a per-call region', async () => {
    await created({ region: 'nyc' }, { region: 'nyc' }, { autoSuspendTimeout: 300 });
    expect(m.create.mock.calls[0][0]).toMatchObject({ region: 'nyc', config: { autoSuspendTimeout: 300 } });
  });

  it('stores envs in the computer, readable by its user only', async () => {
    m.exec.mockResolvedValueOnce(ok());
    const { id } = await created({ envs: { GREETING: 'hi "you" $HOME', COUNT: 3 } });
    const [execId, params] = m.exec.mock.calls[0];
    expect(execId).toBe(id);
    expect(params.command).toBe(
      `umask 077 && mkdir -p /home/boxd/.computesdk && printf '%s' 'export GREETING="hi \\"you\\" \\$HOME"\nexport COUNT="3"\n' > /home/boxd/.computesdk/env`,
    );
  });

  it('refuses an invalid env name before creating anything', async () => {
    await expect(provider().instances.create({ envs: { 'BAD-NAME': 'x' } })).rejects.toThrow(/Invalid environment variable name/);
    expect(m.create).not.toHaveBeenCalled();
  });

  it('deletes the computer when it never becomes ready', async () => {
    const mach = machine();
    m.create.mockResolvedValueOnce(mach);
    m.waitUntilReady.mockRejectedValueOnce(new Error('not ready after 90s'));
    m.delete.mockResolvedValueOnce(undefined);
    await expect(provider().instances.create()).rejects.toThrow('not ready');
    expect(m.delete).toHaveBeenCalledWith(mach.id, { region: 'fra' });
  });

  it('names the computer it could not clean up after a failed create', async () => {
    m.create.mockResolvedValueOnce(machine({ id: 'stuck-1', name: 'computesdk-stuck' }));
    m.waitUntilReady.mockRejectedValueOnce(new Error('not ready after 90s'));
    m.delete.mockRejectedValueOnce(new Error('region unavailable'));
    await expect(provider().instances.create()).rejects.toThrow(
      /computesdk-stuck \(stuck-1\) failed to start .* could not be deleted .*`boxd machine destroy computesdk-stuck`/,
    );
  });

  it('says what to check when boxd refuses the credentials', async () => {
    const refused = new AuthenticationError('invalid token');
    m.create.mockRejectedValueOnce(refused);
    const err = (await provider().instances.create().catch((e: unknown) => e)) as Error & { cause?: unknown };
    expect(err.message).toMatch(/rejected the credentials .* BOXD_ORG/);
    expect(err.cause).toBe(refused);
  });

  it('reports standard size classes as unsupported', async () => {
    expect(provider().sizes.resolve('md').status).toBe('unsupported');
    await expect(provider().instances.create({ sizeClass: 'md' })).rejects.toThrow(/none equals a standard size class/);
  });
});

describe('lookup', () => {
  it('returns null for a computer that does not exist', async () => {
    m.get.mockRejectedValueOnce(new NotFoundError('machine not found', 5));
    expect(await provider().instances.getById('gone')).toBeNull();
  });

  it('lists only computers with the computesdk label, in every region', async () => {
    const a = machine();
    const b = machine({ region: 'nyc' });
    m.list.mockResolvedValueOnce(regional([a, b]));
    const all = await provider().instances.list();
    expect(m.list).toHaveBeenCalledWith({ org: 'acme', region: 'all', labels: { computesdk: 'true' } });
    expect(all.map((s) => s.instanceId)).toEqual([a.id, b.id]);
  });

  it('ignores a computer that is already gone on destroy', async () => {
    m.delete.mockRejectedValueOnce(new NotFoundError('machine not found', 5));
    await expect(provider().instances.destroy('gone')).resolves.toBeUndefined();
    expect(m.delete).toHaveBeenCalledTimes(1);
  });
});

describe('runCommand', () => {
  it('reads the stored envs, exports the call env, groups the command and passes cwd', async () => {
    const { sandbox, id } = await created();
    m.exec.mockResolvedValueOnce(ok('ok\n'));
    const result = await sandbox.runCommand('echo $B', { env: { B: 'two "q"' }, cwd: '/tmp' });
    expect(m.exec).toHaveBeenCalledWith(id, {
      command: '[ -r /home/boxd/.computesdk/env ] && . /home/boxd/.computesdk/env; export B="two \\"q\\""; { echo $B\n}',
      cwd: '/tmp',
      region: 'fra',
    });
    expect(result).toMatchObject({ stdout: 'ok\n', exitCode: 0 });
  });

  it('keeps a & inside the command, so what follows still has the environment', async () => {
    const { sandbox } = await created();
    m.exec.mockResolvedValueOnce(ok());
    await sandbox.runCommand('node server.js & node client.js', { env: { A: '1' } });
    expect(m.exec.mock.calls[0][1].command).toMatch(/export A="1"; \{ node server\.js & node client\.js\n\}$/);
  });

  it('turns env values into strings', async () => {
    const { sandbox } = await created();
    m.exec.mockResolvedValueOnce(ok());
    await sandbox.runCommand('true', { env: { N: 5 as unknown as string } });
    expect(m.exec.mock.calls[0][1].command).toContain('export N="5"');
  });

  it('runs background commands in a session of their own', async () => {
    const { sandbox } = await created();
    m.exec.mockResolvedValueOnce(ok());
    await sandbox.runCommand('node server.js', { background: true });
    expect(m.exec.mock.calls[0][1].command).toBe(
      'setsid nohup sh -c "[ -r /home/boxd/.computesdk/env ] && . /home/boxd/.computesdk/env; { node server.js\n}" </dev/null >/dev/null 2>&1 &',
    );
  });

  it('keeps the output a timed-out command printed and returns 124', async () => {
    const { sandbox } = await created();
    const stream = fakeStream({ stdout: ['started\n'], hang: true });
    m.streamExec.mockReturnValueOnce(stream);
    const result = await sandbox.runCommand('sleep 60', { timeout: 50 });
    expect(m.exec).not.toHaveBeenCalled();
    expect(stream.close).toHaveBeenCalled();
    expect(result).toMatchObject({ stdout: 'started\n', exitCode: 124 });
  });

  it('starts a stopped computer and runs the command again', async () => {
    const { sandbox, id } = await created();
    m.exec.mockRejectedValueOnce(stopped()).mockResolvedValueOnce(ok('back\n'));
    m.waitUntilReady.mockResolvedValueOnce(machine());
    const result = await sandbox.runCommand('echo back');
    expect(m.start).toHaveBeenCalledWith(id, { region: 'fra' });
    expect(result.stdout).toBe('back\n');
  });
});

describe('streaming', () => {
  it('delivers stdout and stderr as they arrive and returns the exit code', async () => {
    const { sandbox } = await created();
    m.streamExec.mockReturnValueOnce(fakeStream({ stdout: ['tick 1\n', 'tick 2\n'], stderr: ['warn\n'], exitCode: 3 }));
    const out: string[] = [];
    const err: string[] = [];
    const result = await sandbox.runCommand('run', { onStdout: (d) => out.push(d), onStderr: (d) => err.push(d) });
    expect(out).toEqual(['tick 1\n', 'tick 2\n']);
    expect(err).toEqual(['warn\n']);
    expect(result).toMatchObject({ stdout: 'tick 1\ntick 2\n', stderr: 'warn\n', exitCode: 3 });
    expect(m.streamExec.mock.calls[0][1]).toMatchObject({ closeStdin: true });
  });

  it('closes the stream and returns 124 on timeout', async () => {
    const { sandbox } = await created();
    const stream = fakeStream({ stdout: ['starting\n'], hang: true });
    m.streamExec.mockReturnValueOnce(stream);
    const result = await sandbox.runCommand('sleep 60', { timeout: 50, onStdout: () => {} });
    expect(stream.close).toHaveBeenCalled();
    expect(result).toMatchObject({ stdout: 'starting\n', exitCode: 124 });
  });

  it('returns on timeout even when the closed stream never ends', async () => {
    const { sandbox } = await created();
    const stream = fakeStream({ stdout: ['partial\n'], never: true });
    m.streamExec.mockReturnValueOnce(stream);
    const result = await sandbox.runCommand('sleep 60', { timeout: 50, onStdout: () => {} });
    expect(stream.close).toHaveBeenCalled();
    expect(result).toMatchObject({ stdout: 'partial\n', exitCode: 124 });
  });

  it('keeps all output when a callback throws, and throws its error after', async () => {
    const { sandbox } = await created();
    m.streamExec.mockReturnValueOnce(fakeStream({ stdout: ['a\n', 'b\n'], exitCode: 0 }));
    const seen: string[] = [];
    await expect(
      sandbox.runCommand('run', {
        onStdout: (d) => {
          seen.push(d);
          throw new Error('callback broke');
        },
      }),
    ).rejects.toThrow('callback broke');
    expect(seen).toEqual(['a\n']);
  });

  it('opens the stream again when nothing was delivered yet', async () => {
    const { sandbox } = await created();
    m.streamExec.mockReturnValueOnce(fakeStream({ fail: notFound() })).mockReturnValueOnce(fakeStream({ stdout: ['hi\n'] }));
    const out: string[] = [];
    const result = await sandbox.runCommand('echo hi', { onStdout: (d) => out.push(d) });
    expect(out).toEqual(['hi\n']);
    expect(result.exitCode).toBe(0);
    expect(m.streamExec).toHaveBeenCalledTimes(2);
  });

  it('does not run a command again once output was delivered', async () => {
    const { sandbox } = await created();
    m.streamExec.mockReturnValueOnce(fakeStream({ stdout: ['partial\n'], fail: stopped(), failAfterMs: 30 }));
    await expect(sandbox.runCommand('run', { onStdout: () => {} })).rejects.toThrow(/is stopped/);
    expect(m.streamExec).toHaveBeenCalledTimes(1);
    expect(m.start).not.toHaveBeenCalled();
  });
});

describe('getInfo', () => {
  it('maps the status, the time left and the metadata', async () => {
    const deleteAt = new Date(Date.now() + 60_000);
    const { sandbox } = await created({}, { deleteAt });
    m.get.mockResolvedValueOnce(machine({ deleteAt, labels: { computesdk: 'true', team: 'a' } }));
    const info = await sandbox.getInfo();
    expect(info.status).toBe('running');
    expect(info.timeout).toBeGreaterThan(55_000);
    expect(info.metadata).toMatchObject({ status: 'running', region: 'fra', org: 'acme', labels: { team: 'a' } });
  });

  it('reports a failed computer as an error', async () => {
    const { sandbox } = await created();
    m.get.mockResolvedValueOnce(machine({ status: 'failed' }));
    expect((await sandbox.getInfo()).status).toBe('error');
  });

  it('reports a computer that is gone as stopped', async () => {
    m.get.mockResolvedValueOnce(machine({ id: 'old-info' }));
    const sandbox = await provider().instances.getById('old-info');
    m.get.mockRejectedValueOnce(notFound());
    const info = await sandbox!.getInfo();
    expect(info.status).toBe('stopped');
    expect(info.metadata?.status).toBe('destroyed');
  });
});

describe('getUrl', () => {
  const route = (name: string | null, port: number, domain: string, isDefault = false) => ({ name, port, domain, isDefault });

  it('reuses a named route on the port once it answers', async () => {
    const { sandbox } = await created();
    proxies.list.mockResolvedValueOnce([route(null, 3000, 'computesdk-test.boxd.sh', true), route('web', 3000, 'web.computesdk-test.boxd.sh')]);
    expect(await sandbox.getUrl({ port: 3000 })).toBe('https://web.computesdk-test.boxd.sh');
    expect(proxies.create).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith('https://web.computesdk-test.boxd.sh/__boxd/ready', expect.anything());
  });

  it('makes a route for a new port', async () => {
    const { sandbox, id } = await created();
    proxies.list.mockResolvedValueOnce([]).mockResolvedValueOnce([route('p8080', 8080, 'p8080.computesdk-test.boxd.sh')]);
    proxies.create.mockResolvedValueOnce({ name: 'p8080', port: 8080 });
    expect(await sandbox.getUrl({ port: 8080, protocol: 'wss' })).toBe('wss://p8080.computesdk-test.boxd.sh');
    expect(proxies.create).toHaveBeenCalledWith(id, 'p8080', 8080, { region: 'fra' });
  });

  it('waits until the new URL answers', async () => {
    const { sandbox } = await created();
    proxies.list.mockResolvedValueOnce([route('p3000', 3000, 'p3000.computesdk-test.boxd.sh')]);
    const pending = new Response(null, { status: 502, headers: { 'x-boxd-proxy': 'placeholder' } });
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(pending).mockResolvedValueOnce(ready());
    await sandbox.getUrl({ port: 3000 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('stops waiting for a certificate that will never be trusted', async () => {
    const { sandbox } = await created();
    proxies.list.mockResolvedValueOnce([route('p3000', 3000, 'p3000.computesdk-test.boxd.test')]);
    vi.mocked(fetch).mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } }));
    expect(await sandbox.getUrl({ port: 3000 })).toBe('https://p3000.computesdk-test.boxd.test');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns at once with urlReadyTimeout 0', async () => {
    const { sandbox } = await created({}, {}, { urlReadyTimeout: 0 });
    proxies.list.mockResolvedValueOnce([route('p3000', 3000, 'p3000.computesdk-test.boxd.sh')]);
    await sandbox.getUrl({ port: 3000 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the route a concurrent getUrl made first', async () => {
    const { sandbox } = await created();
    proxies.list.mockResolvedValueOnce([]).mockResolvedValueOnce([route('p3000', 3000, 'p3000.computesdk-test.boxd.sh')]);
    proxies.create.mockRejectedValueOnce(new ConflictError('proxy p3000 already exists', 6));
    expect(await sandbox.getUrl({ port: 3000 })).toBe('https://p3000.computesdk-test.boxd.sh');
  });

  it("gives ComputeSDK's process daemon no public URL", async () => {
    const { sandbox } = await created();
    await expect(sandbox.getUrl({ port: 38989 })).rejects.toThrow(/polled instead/);
    expect(proxies.create).not.toHaveBeenCalled();
  });
});

describe('filesystem', () => {
  it('lists a directory', async () => {
    const { sandbox } = await created();
    fs.list.mockResolvedValueOnce([
      { name: 'a.txt', isDir: false, size: 3, mtime: new Date(0) },
      { name: 'sub', isDir: true, size: 0, mtime: new Date(0) },
    ]);
    const entries = await sandbox.filesystem.readdir('/tmp');
    expect(entries.map((e) => [e.name, e.type])).toEqual([['a.txt', 'file'], ['sub', 'directory']]);
  });

  it('reads and writes text', async () => {
    const { sandbox, id } = await created();
    fs.read.mockResolvedValueOnce(new TextEncoder().encode('héllo'));
    expect(await sandbox.filesystem.readFile('/tmp/x')).toBe('héllo');
    await sandbox.filesystem.writeFile('/tmp/y', 'data');
    expect(fs.write).toHaveBeenCalledWith(id, '/tmp/y', 'data', { region: 'fra' });
  });

  it('accepts mkdir of a directory that exists, and says whether a path exists', async () => {
    const { sandbox } = await created();
    fs.mkdir.mockRejectedValueOnce(new MachineFileExistsError('exists'));
    fs.stat.mockResolvedValueOnce({ isDir: true });
    await expect(sandbox.filesystem.mkdir('/tmp/d')).resolves.toBeUndefined();
    fs.exists.mockResolvedValueOnce(false);
    expect(await sandbox.filesystem.exists('/tmp/none')).toBe(false);
  });

  it('ignores removing a path that does not exist', async () => {
    const { sandbox } = await created();
    fs.remove.mockRejectedValueOnce(new MachineFileNotFoundError('not found'));
    await expect(sandbox.filesystem.remove('/tmp/gone')).resolves.toBeUndefined();
  });

  it('refuses to remove the home directory or the root', async () => {
    const { sandbox } = await created();
    for (const path of ['', '.', './', '..', '/', '~']) await expect(sandbox.filesystem.remove(path)).rejects.toThrow(/Refusing/);
    expect(fs.remove).not.toHaveBeenCalled();
  });

  it('does not start a stopped computer to read a file', async () => {
    const { sandbox } = await created();
    fs.read.mockRejectedValueOnce(stopped());
    await expect(sandbox.filesystem.readFile('/tmp/x')).rejects.toThrow(/is stopped/);
    expect(m.start).not.toHaveBeenCalled();
  });
});

describe('volumes', () => {
  it('creates a volume, 10 GiB by default, and waits until it can be mounted', async () => {
    disks.create.mockResolvedValueOnce({ id: 'd-new', name: 'cache', sizeBytes: 10 * 1024 ** 3, status: 'creating' });
    disks.list
      .mockResolvedValueOnce(regional([disk({ id: 'd-new', status: 'creating' })]))
      .mockResolvedValueOnce(regional([disk({ id: 'd-new', attachments: [{ machineId: 'm-x', machineName: 'x', mountPath: '/data', mountMode: 'ro' }] })]));
    const volume = await provider().volume!.create({ name: 'cache' });
    expect(disks.create).toHaveBeenCalledWith('cache', 10 * 1024 ** 3, {});
    expect(volume).toMatchObject({ id: 'd-new', name: 'cache', status: 'ready', region: 'fra' });
    expect(volume.attachments).toEqual([{ instanceId: 'm-x', name: 'x', mountPath: '/data', readOnly: true }]);
  });

  it('finds a volume by name in every region, and returns null when there is none', async () => {
    disks.list.mockResolvedValueOnce(regional([disk({ region: 'nyc' })])).mockResolvedValueOnce(regional([]));
    expect((await provider().volume!.get('cache'))?.id).toBe('d-1');
    expect(disks.list).toHaveBeenCalledWith({ region: 'all' });
    expect(await provider().volume!.get('nothing')).toBeNull();
  });

  it('lists volumes up to the limit', async () => {
    disks.list.mockResolvedValueOnce(regional([disk(), disk({ id: 'd-2', name: 'b' })]));
    expect((await provider().volume!.list({ limit: 1 })).map((v) => v.id)).toEqual(['d-1']);
  });

  it('deletes a volume by name, and ignores one that is gone', async () => {
    disks.list.mockResolvedValueOnce(regional([disk({ region: 'nyc' })])).mockResolvedValueOnce(regional([]));
    await provider().volume!.delete('cache');
    expect(disks.delete).toHaveBeenCalledWith('d-1', { region: 'nyc' });
    await provider().volume!.delete('gone');
    expect(disks.delete).toHaveBeenCalledTimes(1);
  });

  // Errors the factory retries for up to three minutes, reading them as a disk still in use elsewhere.
  const RETRIED = /attached|mounted|in.?use|busy|in_use|still in use|sync.?pending|pending_create/i;
  const attachedHere = (id: string, mountPath = '/data', mountMode = 'rw') => [{ machineId: id, machineName: 'x', mountPath, mountMode }];
  const freezes = (path: string) => `for p in '${path}'; do mountpoint -q "$p" && sudo -n fsfreeze -f "$p"; done`;

  it('mounts volumes at create, in the region of their disks, and checks they mounted', async () => {
    disks.list.mockResolvedValueOnce(regional([disk({ region: 'nyc' })]));
    m.exec.mockResolvedValueOnce(ok(''));
    await created({ volumes: [{ volume: 'cache', mountPath: '/data', readOnly: true }] }, { region: 'nyc' });
    expect(m.create.mock.calls[0][0]).toMatchObject({ region: 'nyc', config: { volumes: [{ diskId: 'd-1', mountPath: '/data', readOnly: true }] } });
    expect(m.exec.mock.calls[0][1].command).toBe(`for p in '/data'; do mountpoint -q "$p" || echo "$p"; done`);
  });

  it('fails the create, and deletes the computer, when a volume did not mount', async () => {
    const mach = machine();
    disks.list.mockResolvedValueOnce(regional([disk()]));
    m.create.mockResolvedValueOnce(mach);
    m.waitUntilReady.mockResolvedValueOnce(mach);
    m.exec.mockResolvedValue(ok('/data\n'));
    const err = (await provider()
      .instances.create({ volumes: [{ volume: 'cache', mountPath: '/data', readOnly: true }] })
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/didn't mount \/data: a read-only mount fails .* Mount it read-write once/);
    expect(err.message).not.toMatch(RETRIED);
    expect(m.delete).toHaveBeenCalledWith(mach.id, { region: 'fra' });
  });

  it('passes boxd volume mounts through as they are', async () => {
    m.exec.mockResolvedValueOnce(ok(''));
    await created({ volumes: [{ diskId: 'd-9', mountPath: '/data' }] });
    expect(m.create.mock.calls[0][0].config).toEqual({ volumes: [{ diskId: 'd-9', mountPath: '/data', readOnly: false }] });
    expect(disks.list).not.toHaveBeenCalled();
  });

  it('refuses volumes from two regions, or from another region than asked', async () => {
    disks.list.mockResolvedValueOnce(regional([disk(), disk({ id: 'd-2', name: 'b', region: 'nyc' })]));
    await expect(
      provider().instances.create({ volumes: [{ volume: 'cache', mountPath: '/a' }, { volume: 'b', mountPath: '/b' }] }),
    ).rejects.toThrow(/one region/);
    disks.list.mockResolvedValueOnce(regional([disk({ region: 'nyc' })]));
    await expect(provider().instances.create({ region: 'fra', volumes: [{ volume: 'cache', mountPath: '/a' }] })).rejects.toThrow(/created there/);
    expect(m.create).not.toHaveBeenCalled();
  });

  it('attaches a volume to a running computer and restarts it, so the volume appears', async () => {
    const { sandbox, id } = await created();
    disks.list.mockResolvedValueOnce(regional([disk()])).mockResolvedValueOnce(regional([disk({ attachments: attachedHere(id, '/mnt/cache') })]));
    m.get.mockResolvedValueOnce(machine());
    m.exec.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok(''));
    m.waitUntilReady.mockResolvedValueOnce(machine());
    await sandbox.attachVolume!('cache', '/mnt/cache');
    expect(disks.attach).toHaveBeenCalledWith('d-1', id, '/mnt/cache', { region: 'fra' });
    expect(m.stop).toHaveBeenCalledWith(id, { region: 'fra' });
    expect(m.start).toHaveBeenCalledWith(id, { region: 'fra' });
    expect(m.exec.mock.calls[1][1].command).toContain('mountpoint -q');
  });

  it('restarts once more when the attached volume did not appear', async () => {
    const { sandbox, id } = await created();
    const mounted = regional([disk({ attachments: attachedHere(id, '/mnt/cache') })]);
    disks.list.mockResolvedValueOnce(regional([disk()])).mockResolvedValue(mounted);
    m.get.mockResolvedValueOnce(machine());
    m.waitUntilReady.mockResolvedValue(machine());
    // Missing until the computer has booted a second time.
    m.exec.mockImplementation(async (_id: string, params: { command: string }) =>
      params.command.includes('|| echo') ? ok(m.start.mock.calls.length >= 2 ? '' : '/mnt/cache\n') : ok(),
    );
    await sandbox.attachVolume!('cache', '/mnt/cache');
    expect(m.start).toHaveBeenCalledTimes(2);
  });

  it('attaches a volume to a stopped computer without starting it', async () => {
    const { sandbox } = await created();
    disks.list.mockResolvedValueOnce(regional([disk()]));
    m.get.mockResolvedValueOnce(machine({ status: 'stopped' }));
    await sandbox.attachVolume!('cache', '/mnt/cache');
    expect(m.stop).not.toHaveBeenCalled();
    expect(m.start).not.toHaveBeenCalled();
  });

  it('says to mount at create when the disk is on another host', async () => {
    const { sandbox } = await created();
    disks.list.mockResolvedValueOnce(regional([disk()]));
    disks.attach.mockRejectedValueOnce(
      new BoxdError('disk placement: disk is on worker w1, VM is on worker w2 — create the VM with this disk in config.volumes so it is placed alongside the disk', 9),
    );
    const err = (await sandbox.attachVolume!('cache', '/mnt/cache').catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/create\(\{ volumes \}\)/);
    expect(err.message).not.toMatch(RETRIED);
  });

  it('detaches from a running computer by stopping it cleanly around the detach', async () => {
    const { sandbox, id } = await created();
    const mounted = regional([disk({ attachments: attachedHere(id) })]);
    disks.list.mockResolvedValueOnce(mounted).mockResolvedValueOnce(mounted);
    disks.detach
      .mockRejectedValueOnce(new ConflictError("machine x is 'running' — stop it before detaching cache, so the guest releases the disk", 9))
      .mockResolvedValueOnce(undefined);
    m.exec.mockResolvedValueOnce(ok());
    m.waitUntilReady.mockResolvedValueOnce(machine());
    await sandbox.detachVolume!('cache');
    expect(m.exec.mock.calls[0][1].command).toBe(freezes('/data'));
    const order = [m.exec, m.stop, disks.detach, m.start].map((fn) => fn.mock.invocationCallOrder.at(-1)!);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('thaws the disks and says so when the stop fails', async () => {
    const { sandbox, id } = await created();
    const mounted = regional([disk({ attachments: attachedHere(id) })]);
    disks.list.mockResolvedValueOnce(mounted).mockResolvedValueOnce(mounted);
    disks.detach.mockRejectedValueOnce(new ConflictError("machine x is 'running' — stop it before detaching cache", 9));
    m.exec.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok());
    m.stop.mockRejectedValueOnce(new Error('stop failed'));
    await expect(sandbox.detachVolume!('cache')).rejects.toThrow('stop failed');
    expect(m.exec.mock.calls[1][1].command).toContain('fsfreeze -u');
    expect(m.start).not.toHaveBeenCalled();
  });

  it('does nothing to detach a volume that is not on the computer', async () => {
    const { sandbox } = await created();
    disks.list.mockResolvedValueOnce(regional([disk()]));
    await sandbox.detachVolume!('cache');
    expect(disks.detach).not.toHaveBeenCalled();
    expect(m.stop).not.toHaveBeenCalled();
  });

  it('freezes and stops a computer with a volume before deleting it, so its writes reach the disk', async () => {
    disks.list.mockResolvedValueOnce(regional([disk()]));
    m.exec.mockResolvedValueOnce(ok(''));
    const { sandbox, id } = await created({ volumes: [{ volume: 'cache', mountPath: '/data' }] });
    disks.list.mockResolvedValueOnce(regional([disk({ attachments: attachedHere(id) })]));
    m.exec.mockResolvedValueOnce(ok());
    await sandbox.destroy();
    expect(m.exec.mock.calls[1]).toEqual([id, { command: freezes('/data'), timeout: 30_000, region: 'fra' }]);
    expect(m.exec.mock.invocationCallOrder[1]).toBeLessThan(m.stop.mock.invocationCallOrder[0]);
    expect(m.stop.mock.invocationCallOrder[0]).toBeLessThan(m.delete.mock.invocationCallOrder[0]);
  });

  it('checks for volumes before deleting a computer it did not create', async () => {
    disks.list.mockResolvedValueOnce(regional([disk({ attachments: attachedHere('old-vol', '/d') })]));
    await provider().instances.destroy('old-vol');
    expect(m.exec).toHaveBeenCalledWith('old-vol', { command: freezes('/d'), timeout: 30_000 });
    expect(m.stop).toHaveBeenCalledWith('old-vol', {});
    expect(m.delete).toHaveBeenCalledWith('old-vol', {});
  });

  it('only stops a computer whose disk is mounted read-only', async () => {
    disks.list.mockResolvedValueOnce(regional([disk({ attachments: attachedHere('old-ro', '/d', 'ro') })]));
    await provider().instances.destroy('old-ro');
    expect(m.exec).not.toHaveBeenCalled();
    expect(m.stop).toHaveBeenCalledWith('old-ro', {});
  });

  it('deletes a computer created without volumes at once', async () => {
    const { sandbox } = await created();
    await sandbox.destroy();
    expect(disks.list).not.toHaveBeenCalled();
    expect(m.stop).not.toHaveBeenCalled();
  });
});

// boxd answers "not found" for a computer in another region than the one asked, and for a
// moment about one it has just created. A listing of every region decides.
describe('regions and "not found"', () => {
  it('destroys a computer in another region, found by id', async () => {
    m.delete.mockRejectedValueOnce(notFound()).mockResolvedValueOnce(undefined);
    m.list.mockResolvedValueOnce(regional([machine({ id: 'nyc-1', region: 'nyc' })]));
    await provider().instances.destroy('nyc-1');
    expect(m.list).toHaveBeenCalledWith({ org: 'acme', region: 'all' });
    expect(m.delete).toHaveBeenNthCalledWith(1, 'nyc-1', {});
    expect(m.delete).toHaveBeenNthCalledWith(2, 'nyc-1', { region: 'nyc' });
  });

  it('gets a computer in another region, found by id', async () => {
    m.get.mockRejectedValueOnce(notFound()).mockResolvedValueOnce(machine({ id: 'nyc-2', region: 'nyc' }));
    m.list.mockResolvedValueOnce(regional([machine({ id: 'nyc-2', region: 'nyc' })]));
    const found = await provider().instances.getById('nyc-2');
    expect(found?.getInstance().region).toBe('nyc');
    expect(m.get).toHaveBeenLastCalledWith('nyc-2', { region: 'nyc' });
  });

  it("doesn't believe a computer is gone while a region can't be listed", async () => {
    m.delete.mockRejectedValueOnce(notFound());
    m.list.mockResolvedValueOnce(regional([], ['nyc']));
    await expect(provider().instances.destroy('maybe-1')).rejects.toThrow(/couldn't list region nyc/);
  });

  it('retries a call while the listing still shows the computer', async () => {
    m.get.mockResolvedValueOnce(machine({ id: 'old-1' }));
    const sandbox = await provider().instances.getById('old-1');
    m.exec.mockRejectedValueOnce(notFound()).mockResolvedValueOnce(ok('ok\n'));
    m.list.mockResolvedValueOnce(regional([machine({ id: 'old-1' })]));
    expect((await sandbox!.runCommand('echo ok')).stdout).toBe('ok\n');
    expect(m.exec).toHaveBeenCalledTimes(2);
  });

  it('believes "not found" once the listing agrees', async () => {
    m.get.mockResolvedValueOnce(machine({ id: 'old-2' }));
    const sandbox = await provider().instances.getById('old-2');
    m.exec.mockRejectedValueOnce(notFound());
    await expect(sandbox!.runCommand('echo ok')).rejects.toThrow('VM not found');
    expect(m.exec).toHaveBeenCalledTimes(1);
  });

  it('retries a computer it just created, even before the listing shows it', async () => {
    const { sandbox } = await created();
    m.exec.mockRejectedValueOnce(notFound()).mockResolvedValueOnce(ok('ok\n'));
    expect((await sandbox.runCommand('echo ok')).stdout).toBe('ok\n');
  });

  it('waits out a "not found" while a new computer becomes ready', async () => {
    const mach = machine();
    m.create.mockResolvedValueOnce(mach);
    m.waitUntilReady.mockRejectedValueOnce(notFound()).mockResolvedValueOnce(mach);
    const sandbox = await provider().instances.create();
    expect(sandbox.instanceId).toBe(mach.id);
    expect(m.delete).not.toHaveBeenCalled();
  });

  it('creates from a snapshot kept in another region', async () => {
    m.create.mockRejectedValueOnce(new NotFoundError('snapshot not found', 5)).mockResolvedValueOnce(machine({ id: 'r-1', region: 'nyc' }));
    snapshots.list.mockResolvedValueOnce(regional([{ id: 'snap-nyc', name: 'golden', region: 'nyc' }]));
    m.waitUntilReady.mockResolvedValueOnce(machine({ id: 'r-1', region: 'nyc' }));
    await provider().instances.create({ snapshotId: 'snap-nyc' });
    expect(snapshots.list).toHaveBeenCalledWith({ org: 'acme', region: 'all' });
    expect(m.create.mock.calls[1][0]).toMatchObject({ fromSnapshot: 'snap-nyc', region: 'nyc' });
  });

  it('deletes a snapshot kept in another region', async () => {
    snapshots.delete.mockRejectedValueOnce(new NotFoundError('snapshot not found', 5)).mockResolvedValueOnce(undefined);
    snapshots.list.mockResolvedValueOnce(regional([{ id: 'snap-nyc', name: 'golden', region: 'nyc' }]));
    await provider().snapshot!.delete('snap-nyc');
    expect(snapshots.delete).toHaveBeenLastCalledWith('snap-nyc', { org: 'acme', region: 'nyc' });
  });
});

describe('snapshots', () => {
  it('waits until the version it captured is ready', async () => {
    snapshots.create.mockResolvedValueOnce({ id: 'snap-1', name: 'golden', version: 2, status: 'pending' });
    snapshots.get
      .mockResolvedValueOnce({ id: 'snap-1', name: 'golden', version: 1, status: 'ready' })
      .mockResolvedValueOnce({ id: 'snap-1', name: 'golden', version: 2, status: 'ready', createdAt: new Date(0), sizeBytes: 10 });
    const snapshot = await provider().snapshot!.create('m-snap', { name: 'golden' });
    expect(snapshots.create).toHaveBeenCalledWith('m-snap', 'golden', {});
    expect(snapshots.get).toHaveBeenCalledTimes(2);
    expect(snapshot).toMatchObject({ id: 'snap-1', provider: 'boxd', metadata: { version: 2 } });
  });

  it('names its snapshots after the computer, and says which one failed', async () => {
    snapshots.create.mockResolvedValueOnce({ id: 'snap-2', name: 'computesdk-snap-abcdef12-123456', version: 1, status: 'pending' });
    snapshots.get.mockResolvedValueOnce({ id: 'snap-2', name: 'computesdk-snap-abcdef12-123456', version: null, status: 'failed' });
    await expect(provider().snapshot!.create('abcdef12-0000-0000-0000-000000000000')).rejects.toThrow(/\(snap-2\) version 1 failed/);
    expect(snapshots.create.mock.calls[0][1]).toMatch(/^computesdk-snap-abcdef12-[0-9a-f]{6}$/);
  });

  it('lists the snapshots of one computer, up to the limit', async () => {
    snapshots.list.mockResolvedValue(
      regional([
        { id: 's-1', name: 'computesdk-snap-abcdef12-111111', status: 'ready' },
        { id: 's-2', name: 'computesdk-snap-99999999-222222', status: 'ready' },
        { id: 's-3', name: 'computesdk-snap-abcdef12-333333', status: 'ready' },
      ]),
    );
    const mine = await provider().snapshot!.list({ instanceId: 'abcdef12-0000-0000-0000-000000000000' });
    expect(mine.map((s) => s.id)).toEqual(['s-1', 's-3']);
    expect(snapshots.list).toHaveBeenCalledWith({ org: 'acme', region: 'all' });
    expect((await provider().snapshot!.list({ limit: 2 })).map((s) => s.id)).toEqual(['s-1', 's-2']);
  });
});
