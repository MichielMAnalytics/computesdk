/**
 * boxd Provider - Factory-based Implementation
 *
 * Linux computers on boxd (https://boxd.sh): each one is its own microVM that boots in
 * milliseconds, keeps its disk until it is destroyed, and can be snapshotted and restored.
 * This package talks to boxd through the official `@boxd-sh/sdk`. The SDK is ESM-only, so
 * the CommonJS build bundles it (see tsup.config.ts).
 *
 * Every computer this provider creates is isolated: boxd removes the in-machine boxd CLI,
 * integrations, agent logins and the laptop bridge from it, which is what code from a user
 * or an agent should run in.
 */

import {
  AuthenticationError,
  Boxd,
  BoxdError,
  ConflictError,
  MachineFileExistsError,
  MachineFileNotFoundError,
  NotFoundError,
} from '@boxd-sh/sdk';
import type { Disk, Machine, MachineConfig, MachineCreateParams, Snapshot as BoxdSnapshot } from '@boxd-sh/sdk';
import { defineProvider, escapeShellArg, isUnifiedVolumeMounts, resolveVolumeRef, TIMEOUT_EXIT_CODE } from '@computesdk/provider';
import type {
  CommandResult,
  CreateInstanceOptions,
  CreateSnapshotOptions,
  CreateVolumeOptions,
  FileEntry,
  InstanceInfo,
  ListSnapshotsOptions,
  ListVolumesOptions,
  RunCommandOptions,
  Volume,
  VolumeRef,
} from '@computesdk/provider';
import type { Snapshot } from 'computesdk';

export interface BoxdConfig {
  /** boxd API key - falls back to BOXD_API_KEY. Make one with `boxd auth keys create <name> --org <org>`. */
  apiKey?: string;
  /** boxd session token, used instead of an API key - falls back to BOXD_TOKEN */
  token?: string;
  /** Org (name or id) to create and list computers in - falls back to BOXD_ORG. An API key belongs to one org already. */
  org?: string;
  /** Region to create computers in (e.g. `fra`, `nyc`) - falls back to BOXD_REGION, then the boxd default (Frankfurt). Lists cover every region unless it is set. */
  region?: string;
  /** API endpoint - falls back to BOXD_BASE_URL, then boxd production */
  baseURL?: string;
  /** Default lifetime of a computer in milliseconds, for a create that passes no `timeout`. Unset: a computer lives until it is destroyed. */
  timeout?: number;
  /** Deadline for each call to the boxd API, in milliseconds */
  requestTimeout?: number;
  /** Seconds of inactivity before a computer is suspended (the next request wakes it); 0 never suspends. Unset: your org's default. */
  autoSuspendTimeout?: number;
  /** How long `getUrl` waits for a new URL to answer, in milliseconds. A computer's first URL waits for its certificate, about 20 s. Default 90 000; 0 returns at once. */
  urlReadyTimeout?: number;
}

/** A computer as this provider hands it out. */
export interface BoxdInstance {
  id: string;
  name: string;
  region?: string;
  org?: string;
  /** Environment variables from `create({ envs })`. They are also stored in the computer, so a reconnected instance's commands get them too. */
  envs: Record<string, string>;
  machine: Machine;
  client: Boxd;
}

/** A boxd disk, as `provider.volume` hands it out. */
export interface BoxdVolume extends Volume {
  id: string;
  name: string;
  sizeBytes: number;
  /** `creating`, `ready` or `destroyed` */
  status: string;
  region: string | null;
  createdAt: Date | null;
  /** Where the disk is mounted. boxd mounts a disk on one computer at a time. */
  attachments: Array<{ instanceId: string; name: string; mountPath: string; readOnly: boolean }>;
  native: Disk;
}

/** The sizes boxd offers, as vCPUs and memory in GiB. */
const SIZES: ReadonlyArray<{ vcpu: number; memoryGiB: number }> = [
  { vcpu: 1, memoryGiB: 4 },
  { vcpu: 2, memoryGiB: 8 },
  { vcpu: 4, memoryGiB: 16 },
  { vcpu: 8, memoryGiB: 32 },
];
const SIZE_LIST = SIZES.map((s) => `${s.vcpu} vCPU / ${s.memoryGiB} GiB`).join(', ');
const LABEL = { computesdk: 'true' } as const;
const SNAPSHOT_READY_TIMEOUT_MS = 120_000;
/** Snapshot names this provider makes start with this, then the computer's id (see `snapshot.list`). */
const SNAPSHOT_PREFIX = 'computesdk-snap-';
/** Pauses between retries of a "not found" that boxd may not mean (see `onComputer`). */
const NOT_FOUND_RETRY_MS = [250, 500, 1000, 2000];
/** A computer this process created less than this long ago is known to exist. */
const JUST_CREATED_MS = 60_000;
/** A volume created without a size gets this many bytes. */
const DEFAULT_VOLUME_BYTES = 10 * 1024 ** 3;
const VOLUME_READY_TIMEOUT_MS = 120_000;
/** Where `create({ envs })` are kept in the computer: readable by its user only, read by every command. */
const ENV_DIR = '/home/boxd/.computesdk';
const ENV_FILE = `${ENV_DIR}/env`;
/** `getUrl`'s wait: a computer's first URL needs its certificate issued, a later one only its route. */
const URL_READY_TIMEOUT_MS = 90_000;
const URL_ROUTE_TIMEOUT_MS = 10_000;
/** boxd's proxy answers this path itself (`x-boxd-proxy: ready`) once a URL has its route and certificate. */
const READY_PATH = '/__boxd/ready';
/** Certificates that waiting won't make trusted, such as a dev cluster's self-signed one. */
const UNTRUSTED_CERT_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
]);
/** The port ComputeSDK's process daemon (daemond) streams its events on. */
const DAEMON_EVENTS_PORT = 38989;
/** How long a timed-out command's stream gets to hand over the output it has. */
const STREAM_CLOSE_GRACE_MS = 2_000;
/** How long a disk gets to show up mounted once its computer is ready. */
const MOUNT_WAIT_MS = 5_000;

interface ResolvedConfig {
  credential: { token: string } | { apiKey: string };
  org?: string;
  region?: string;
  baseURL?: string;
  timeout?: number;
  requestTimeout?: number;
  autoSuspendTimeout?: number;
  urlReadyTimeout: number;
}

const clients = new Map<string, Boxd>();

function resolveConfig(config: BoxdConfig): ResolvedConfig {
  const env = typeof process !== 'undefined' ? process.env : undefined;
  // The SDK's own order: a token passed in, a key passed in, then the environment's token and key.
  const credential = config.token
    ? { token: config.token }
    : config.apiKey
      ? { apiKey: config.apiKey }
      : env?.BOXD_TOKEN
        ? { token: env.BOXD_TOKEN }
        : env?.BOXD_API_KEY
          ? { apiKey: env.BOXD_API_KEY }
          : undefined;
  if (!credential) {
    throw new Error(
      `Missing boxd API key. Provide 'apiKey' in config or set the BOXD_API_KEY environment variable. ` +
        `Create one with \`boxd auth keys create <name> --org <org>\` or in the console at https://app.boxd.sh`,
    );
  }
  return {
    credential,
    org: config.org || env?.BOXD_ORG || undefined,
    region: config.region || env?.BOXD_REGION || undefined,
    baseURL: config.baseURL || env?.BOXD_BASE_URL || undefined,
    timeout: config.timeout,
    requestTimeout: config.requestTimeout,
    autoSuspendTimeout: config.autoSuspendTimeout,
    urlReadyTimeout: config.urlReadyTimeout ?? URL_READY_TIMEOUT_MS,
  };
}

// One client per credential set: it holds the session it exchanged the key for.
function clientFor(config: ResolvedConfig): Boxd {
  const key = JSON.stringify([config.credential, config.baseURL, config.region, config.requestTimeout]);
  let client = clients.get(key);
  if (!client) {
    client = new Boxd({
      ...config.credential,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      ...(config.region ? { region: config.region } : {}),
      ...(config.requestTimeout ? { timeout: config.requestTimeout } : {}),
    });
    clients.set(key, client);
  }
  return client;
}

function regionOpt(region?: string | null): { region?: string } {
  return region ? { region } : {};
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `promise`, or `fallback` once `ms` have passed, whichever comes first. */
async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

// A call that only gets an id can't tell which region the computer is in, so this process
// remembers what it learns about each computer it sees.
const regionOf = new Map<string, string>();
const createdHere = new Map<string, number>();
/** Whether a computer may have a disk mounted (see `stopIfDisks`). Unknown when absent. */
const hasDisks = new Map<string, boolean>();
/** Port URLs known to answer, per computer: its certificate covers every later one. */
const liveUrls = new Map<string, Set<string>>();
const urlTimeouts = new WeakMap<BoxdInstance, number>();

function remember(machine: Machine): void {
  if (machine.region) regionOf.set(machine.id, machine.region);
}

function forget(id: string): void {
  regionOf.delete(id);
  createdHere.delete(id);
  hasDisks.delete(id);
  liveUrls.delete(id);
}

function justCreated(id: string): boolean {
  const at = createdHere.get(id);
  return at !== undefined && Date.now() - at < JUST_CREATED_MS;
}

/**
 * The region a computer is in, from a listing of every region the org has, or undefined when
 * none has it. Throws when a region could not be listed, since the computer may be there.
 */
async function locate(client: Boxd, org: string | undefined, id: string): Promise<string | undefined> {
  const machines = await client.machines.list({ ...(org ? { org } : {}), region: 'all' });
  const found = machines.find((machine) => machine.id === id);
  if (found) return found.region ?? undefined;
  if (machines.unavailable?.length) {
    throw new Error(
      `boxd couldn't list region ${machines.unavailable.join(', ')}, so whether computer ${id} is there is unknown; try again`,
    );
  }
  return undefined;
}

/** The region a snapshot (by id or name) is in, from a listing of every region the org has. */
async function locateSnapshot(client: Boxd, org: string | undefined, idOrName: string): Promise<string | undefined> {
  const snapshots = await client.snapshots.list({ ...(org ? { org } : {}), region: 'all' });
  return snapshots.find((snapshot) => snapshot.id === idOrName || snapshot.name === idOrName)?.region ?? undefined;
}

/**
 * Runs `call` against one computer and decides what a "not found" means, since boxd
 * answers it in two cases where the computer exists:
 *
 * - The computer is in another region than `target.region`: one created with a per-call
 *   `region`, looked up by id. The listing names its region, and the call goes there.
 * - boxd answers "not found" for a moment about a computer it has just created. The call
 *   is retried for a few seconds, unless the listing agrees that the computer is gone.
 *
 * `call` reads `target.region` each time it runs. `canRetry` turns retrying off, for a
 * call that can't be repeated once it has delivered output.
 */
async function onComputer<T>(
  client: Boxd,
  org: string | undefined,
  target: { id: string; region?: string },
  call: () => Promise<T>,
  canRetry: () => boolean = () => true,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof NotFoundError) || !canRetry() || attempt >= NOT_FOUND_RETRY_MS.length) throw err;
      const region = await locate(client, org, target.id);
      if (region && region !== target.region) {
        target.region = region;
        regionOf.set(target.id, region);
        continue;
      }
      if (!region && !justCreated(target.id)) throw err;
      await sleep(NOT_FOUND_RETRY_MS[attempt]);
    }
  }
}

/** A value single-quoted for sh. */
const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The disks on a computer: whether it has any, and where its read-write ones are. */
async function diskMounts(client: Boxd, target: { id: string; region?: string }): Promise<{ any: boolean; readWrite: string[] }> {
  const disks = await client.disks.list(regionOpt(target.region));
  const mine = disks.flatMap((disk) => disk.attachments.filter((a) => a.machineId === target.id));
  return { any: mine.length > 0, readWrite: mine.filter((a) => a.mountMode === 'rw').map((a) => a.mountPath) };
}

/**
 * Stops a computer so that its disks are left clean. boxd's stop doesn't unmount a disk: the
 * filesystem is left needing a recovery that a read-write mount does on its own but a
 * read-only mount can't, so the next read-only mount of it fails. Freezing a filesystem
 * writes it out and marks it clean, and stopping while it's frozen keeps it that way.
 */
async function stopCleanly(client: Boxd, target: { id: string; region?: string }, readWrite: string[]): Promise<void> {
  // Only a path that is a mount point: `fsfreeze` on a plain directory freezes the filesystem it is on.
  const each = (verb: string) => `for p in ${readWrite.map(shQuote).join(' ')}; do mountpoint -q "$p" && sudo -n fsfreeze ${verb} "$p"; done`;
  const run = (command: string) => client.machines.exec(target.id, { command, timeout: 30_000, ...regionOpt(target.region) });
  let frozen = false;
  if (readWrite.length > 0) {
    try {
      await run(each('-f'));
      frozen = true;
    } catch {
      // A computer that is stopped already has nothing left to write out.
    }
  }
  try {
    await client.machines.stop(target.id, regionOpt(target.region));
  } catch (err) {
    if (frozen) await run(`${each('-u')} 2>/dev/null; true`).catch(() => undefined);
    throw err;
  }
}

/**
 * boxd deletes a computer without its guest writing out what it still holds for its disks,
 * so a file written just before is lost or left empty. A computer with a disk is therefore
 * stopped cleanly first; that takes about 0.2 s.
 */
async function releaseDisks(client: Boxd, target: { id: string; region?: string }): Promise<void> {
  if (hasDisks.get(target.id) === false) return;
  try {
    const mounts = await diskMounts(client, target);
    if (mounts.any) await stopCleanly(client, target, mounts.readWrite);
  } catch {
    // Already stopped, or gone: the delete that follows says which.
  }
}

/** Stops a computer cleanly, runs `between`, and starts it again. */
async function restartAround(instance: BoxdInstance, between: () => Promise<unknown>): Promise<void> {
  const mounts = await diskMounts(instance.client, instance);
  await stopCleanly(instance.client, instance, mounts.readWrite);
  try {
    await between();
  } finally {
    await startMachine(instance);
  }
}

/** Deletes a computer. Resolves once it is gone, also when it already was. */
async function deleteComputer(client: Boxd, org: string | undefined, target: { id: string; region?: string }): Promise<void> {
  await releaseDisks(client, target);
  try {
    await onComputer(client, org, target, () => client.machines.delete(target.id, regionOpt(target.region)));
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
  }
  forget(target.id);
}

async function createMachine(client: Boxd, config: ResolvedConfig, params: MachineCreateParams): Promise<Machine> {
  try {
    return await client.machines.create(params);
  } catch (err) {
    if (err instanceof AuthenticationError) {
      const rejected = new Error(
        `boxd rejected the credentials (${err.message}). Check BOXD_API_KEY and that BOXD_ORG is the org the key belongs to.`,
      );
      (rejected as Error & { cause?: unknown }).cause = err;
      throw rejected;
    }
    // A snapshot is kept in the region of the computer it was taken from.
    if (err instanceof NotFoundError && params.fromSnapshot && !params.region) {
      const region = await locateSnapshot(client, config.org, params.fromSnapshot).catch(() => undefined);
      if (region) return client.machines.create({ ...params, region });
    }
    throw err;
  }
}

function toInstance(client: Boxd, config: ResolvedConfig, machine: Machine, envs: Record<string, string> = {}): BoxdInstance {
  const instance: BoxdInstance = {
    id: machine.id,
    name: machine.name,
    region: machine.region ?? config.region,
    org: config.org,
    envs,
    machine,
    client,
  };
  urlTimeouts.set(instance, config.urlReadyTimeout);
  return instance;
}

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0');
}

function firstNumber(...values: unknown[]): number | undefined {
  return values.find((v): v is number => typeof v === 'number' && v > 0);
}

/** Maps ComputeSDK's CPU and memory fields onto one of the four boxd sizes. */
function machineSize(options: CreateInstanceOptions): { vcpu: number; memory: string } | undefined {
  const vcpu = firstNumber(options.vcpus, options.cpu, options.cpus);
  const memoryMiB = firstNumber(options.memoryMiB, options.memMiB, options.memoryMb, options.memory);
  if (vcpu === undefined && memoryMiB === undefined) return undefined;
  const size = SIZES.find(
    (s) => (vcpu === undefined || s.vcpu === vcpu) && (memoryMiB === undefined || s.memoryGiB * 1024 === memoryMiB),
  );
  if (!size) {
    const asked = [vcpu !== undefined ? `${vcpu} vCPU` : '', memoryMiB !== undefined ? `${memoryMiB} MiB` : '']
      .filter(Boolean)
      .join(' / ');
    throw new Error(`boxd has no size for ${asked}. Pick one of: ${SIZE_LIST} (memory in MiB, e.g. 8192).`);
  }
  return { vcpu: size.vcpu, memory: `${size.memoryGiB}G` };
}

const proxyName = (port: number) => `p${port}`;

/** `create({ ports })`: a named route for each port from the start, so its certificate is issued while the computer boots. */
function portRoutes(ports: unknown): Array<{ name: string; port: number }> {
  if (ports === undefined) return [];
  if (!Array.isArray(ports)) throw new Error('ports must be an array of port numbers');
  return ports.map((port) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port ${port}: a port is 1 to 65535`);
    return { name: proxyName(port), port };
  });
}

/**
 * `create({ metadata })` as boxd labels. A label key is 1 to 63 characters of a-z, 0-9, '.',
 * '_', '/' and '-', starting and ending with a letter or digit, so a key is lowercased and
 * every other character becomes '-': `userId` is stored as `userid`. A value that isn't a
 * string is stored as its JSON.
 */
function metadataLabels(metadata: unknown): Record<string, string> {
  if (!metadata || typeof metadata !== 'object') return {};
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;
    const label = key
      .toLowerCase()
      .replace(/[^a-z0-9._/-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .slice(0, 63)
      .replace(/[^a-z0-9]+$/, '');
    if (!label || label.startsWith('boxd/')) {
      throw new Error(
        `metadata key ${JSON.stringify(key)} can't be a boxd label: keys are lowercase letters, digits, '.', '_', '/' and '-', and 'boxd/' is reserved`,
      );
    }
    labels[label] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return labels;
}

function envName(key: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
  return key;
}

/** Environment variables as strings, their names checked. */
function stringEnvs(envs: unknown): Record<string, string> {
  if (!envs || typeof envs !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(envs)) {
    if (value === undefined || value === null) continue;
    out[envName(key)] = String(value);
  }
  return out;
}

const exportLine = (key: string, value: string) => `export ${key}="${escapeShellArg(value)}"`;

/** Writes `create({ envs })` into the computer, readable by its user only. */
async function writeEnvFile(instance: BoxdInstance, envs: Record<string, string>): Promise<void> {
  const content = Object.entries(envs).map(([key, value]) => `${exportLine(key, value)}\n`).join('');
  const quoted = `'${content.replace(/'/g, `'\\''`)}'`;
  const result = await instance.client.machines.exec(instance.id, {
    command: `umask 077 && mkdir -p ${ENV_DIR} && printf '%s' ${quoted} > ${ENV_FILE}`,
    ...regionOpt(instance.region),
  });
  if (result.exitCode !== 0) throw new Error(`boxd couldn't store the computer's envs (exit ${result.exitCode}): ${result.stderr.trim()}`);
}

interface Mount {
  diskId: string;
  mountPath: string;
  readOnly: boolean;
}

function toVolume(disk: Disk): BoxdVolume {
  return {
    id: disk.id,
    name: disk.name,
    sizeBytes: disk.sizeBytes,
    status: disk.status,
    region: disk.region,
    createdAt: disk.createdAt,
    attachments: disk.attachments.map((a) => ({
      instanceId: a.machineId,
      name: a.machineName,
      mountPath: a.mountPath,
      readOnly: a.mountMode === 'ro',
    })),
    native: disk,
  };
}

/** The disks in `region` when one is given, else in every region the org has. */
const listDisks = (client: Boxd, region: string | undefined) => client.disks.list({ region: region ?? 'all' });

function matchDisk(disks: Disk[], ref: string | VolumeRef): Disk | undefined {
  const { id, name } = resolveVolumeRef(ref);
  return disks.find((disk) => (id !== undefined && disk.id === id) || (name !== undefined && disk.name === name));
}

function noVolume(ref: string | VolumeRef, region: string | undefined): Error {
  const { id, name } = resolveVolumeRef(ref);
  return new Error(`boxd has no volume ${JSON.stringify(id ?? name)}${region ? ` in ${region}` : ''}`);
}

/** A disk by id or name. */
async function findDisk(client: Boxd, region: string | undefined, ref: string | VolumeRef): Promise<Disk | undefined> {
  return matchDisk(await listDisks(client, region), ref);
}

async function requireDisk(client: Boxd, region: string | undefined, ref: string | VolumeRef): Promise<Disk> {
  const disk = await findDisk(client, region, ref);
  if (!disk) throw noVolume(ref, region);
  return disk;
}

/**
 * `create({ volumes })` as boxd's `config.volumes`. A disk lives on one host, so boxd places
 * the computer next to its disks, which therefore must share a region. boxd's own
 * `{ diskId, mountPath, readOnly }` shape passes through.
 */
async function resolveMounts(client: Boxd, config: ResolvedConfig, options: CreateInstanceOptions): Promise<{ volumes: Mount[]; region?: string }> {
  const requested = typeof options.region === 'string' ? options.region : config.region;
  const mounts: unknown = options.volumes;
  if (mounts === undefined || (Array.isArray(mounts) && mounts.length === 0)) return { volumes: [], region: requested };
  if (!isUnifiedVolumeMounts(mounts)) {
    const native = Array.isArray(mounts) && mounts.every((m) => m && typeof m.diskId === 'string' && typeof m.mountPath === 'string');
    if (!native) throw new Error('volumes must be [{ volume, mountPath, readOnly? }]');
    return {
      volumes: (mounts as Array<{ diskId: string; mountPath: string; readOnly?: boolean }>).map((m) => ({
        diskId: m.diskId,
        mountPath: m.mountPath,
        readOnly: m.readOnly === true,
      })),
      region: requested,
    };
  }
  const disks = await listDisks(client, config.region);
  const volumes: Mount[] = [];
  const regions = new Set<string>();
  for (const mount of mounts) {
    const disk = matchDisk(disks, mount.volume);
    if (!disk) throw noVolume(mount.volume, config.region);
    if (disk.region) regions.add(disk.region);
    volumes.push({ diskId: disk.id, mountPath: mount.mountPath, readOnly: mount.readOnly === true });
  }
  if (regions.size > 1) throw new Error(`a boxd computer can only use volumes from one region; these are in ${[...regions].join(' and ')}`);
  const diskRegion = [...regions][0];
  if (requested && diskRegion && requested !== diskRegion) {
    throw new Error(`the volumes are in ${diskRegion}, so the computer has to be created there, not in ${requested}`);
  }
  return { volumes, region: requested ?? diskRegion };
}

/** The paths among `paths` that aren't mounted, given up to MOUNT_WAIT_MS to appear. */
async function missingMounts(instance: BoxdInstance, paths: string[]): Promise<string[]> {
  const deadline = Date.now() + MOUNT_WAIT_MS;
  for (;;) {
    const result = await instance.client.machines.exec(instance.id, {
      command: `for p in ${paths.map(shQuote).join(' ')}; do mountpoint -q "$p" || echo "$p"; done`,
      ...regionOpt(instance.region),
    });
    const missing = result.stdout.split('\n').filter(Boolean);
    if (missing.length === 0 || Date.now() >= deadline) return missing;
    await sleep(500);
  }
}

/**
 * boxd boots a computer whether or not its disks mounted, so this checks that they did. A
 * read-only mount fails while the disk still needs the recovery a read-write mount does on
 * its own, after a computer stopped without unmounting it (see `stopCleanly`).
 */
async function checkMounts(instance: BoxdInstance, mounts: Array<{ mountPath: string; readOnly: boolean }>): Promise<void> {
  const missing = await missingMounts(instance, mounts.map((mount) => mount.mountPath));
  if (missing.length === 0) return;
  // The factory retries a create whose error reads like a disk still in use elsewhere, so
  // this one keeps clear of those words.
  const readOnly = mounts.some((mount) => mount.readOnly && missing.includes(mount.mountPath));
  throw new Error(
    `boxd didn't mount ${missing.join(', ')}` +
      (readOnly
        ? ': a read-only mount fails while the disk still needs the recovery a read-write mount does, after a computer stopped without unmounting it. Mount it read-write once, then read-only works.'
        : '.'),
  );
}

async function readyDisk(client: Boxd, id: string, region: string | undefined): Promise<Disk> {
  const deadline = Date.now() + VOLUME_READY_TIMEOUT_MS;
  for (;;) {
    const disk = (await client.disks.list(regionOpt(region))).find((d) => d.id === id);
    if (disk?.status === 'ready') return disk;
    if (!disk || disk.status === 'destroyed' || Date.now() >= deadline) {
      throw new Error(`boxd volume ${id} is ${disk?.status ?? 'gone'} instead of ready`);
    }
    await sleep(500);
  }
}

function createParams(config: ResolvedConfig, options: CreateInstanceOptions, mounts: { volumes: Mount[]; region?: string }): MachineCreateParams {
  if (options.image) {
    throw new Error(
      `boxd computers boot from the boxd base image (Ubuntu 24.04 with Docker, Node, Python and Go). ` +
        `Set up a computer once, snapshot it, and pass its id as 'snapshotId' instead of 'image'.`,
    );
  }
  const fromSnapshot = options.snapshotId ?? options.templateId;
  const size = machineSize(options);
  if (fromSnapshot && size) {
    throw new Error('A boxd computer created from a snapshot keeps the snapshot\'s size, so vcpus/memory cannot be set with it.');
  }
  const routes = portRoutes(options.ports);
  const machineConfig: MachineConfig = {
    ...(size ?? {}),
    ...(config.autoSuspendTimeout !== undefined ? { autoSuspendTimeout: config.autoSuspendTimeout } : {}),
    ...(mounts.volumes.length > 0 ? { volumes: mounts.volumes } : {}),
    ...(routes.length > 0 ? { proxies: routes } : {}),
  };
  const lifetime = typeof options.timeout === 'number' ? options.timeout : config.timeout;
  const common = {
    name: options.name || `computesdk-${randomSuffix()}`,
    ...(config.org ? { org: config.org } : {}),
    ...regionOpt(mounts.region),
    isolated: true,
    labels: { ...metadataLabels(options.metadata), ...LABEL },
    ...(typeof lifetime === 'number' && lifetime > 0 ? { deleteAfter: Math.ceil(lifetime / 1000) } : {}),
    ...(Object.keys(machineConfig).length > 0 ? { config: machineConfig } : {}),
  };
  return fromSnapshot ? { ...common, fromSnapshot } : common;
}

function isStopped(err: unknown): boolean {
  return err instanceof ConflictError && /is stopped/i.test(err.message);
}

async function startMachine(instance: BoxdInstance): Promise<void> {
  await instance.client.machines.start(instance.id, regionOpt(instance.region));
  await instance.client.machines.waitUntilReady(instance.id, regionOpt(instance.region));
}

/**
 * A call on a computer, through `onComputer`. With `start`, a stopped computer is started and
 * the call made again: a stopped computer doesn't wake on its own, unlike a suspended or
 * hibernated one. Only commands do that, so reading a file or the computer's state never
 * boots one.
 */
async function onInstance<T>(
  instance: BoxdInstance,
  fn: () => Promise<T>,
  opts: { start?: boolean; canRetry?: () => boolean } = {},
): Promise<T> {
  const canRetry = opts.canRetry ?? (() => true);
  const run = () => onComputer(instance.client, instance.org, instance, fn, canRetry);
  try {
    return await run();
  } catch (err) {
    if (!opts.start || !isStopped(err) || !canRetry()) throw err;
    await startMachine(instance);
    return await run();
  }
}

/**
 * The command as boxd runs it: the computer's stored envs and this call's `env` first, then
 * the command in a group of its own, so a `&` in it backgrounds only its own part and what
 * follows still has the environment (and the `cwd` boxd puts in front of it all).
 */
function shellCommand(command: string, options?: RunCommandOptions): string {
  const setup = [
    `[ -r ${ENV_FILE} ] && . ${ENV_FILE}`,
    ...Object.entries(stringEnvs(options?.env)).map(([key, value]) => exportLine(key, value)),
  ];
  const cmd = `${setup.join('; ')}; { ${command}\n}`;
  // Its own session, so it outlives the exec that started it.
  return options?.background ? `setsid nohup sh -c "${escapeShellArg(cmd)}" </dev/null >/dev/null 2>&1 &` : cmd;
}

function infoStatus(status: string): InstanceInfo['status'] {
  if (status === 'failed') return 'error';
  if (status === 'stopped' || status === 'destroyed') return 'stopped';
  return 'running';
}

function toSnapshot(snapshot: BoxdSnapshot): Snapshot {
  return {
    id: snapshot.id,
    provider: 'boxd',
    createdAt: snapshot.createdAt ?? new Date(),
    metadata: {
      name: snapshot.name,
      version: snapshot.version,
      status: snapshot.status,
      sizeBytes: snapshot.sizeBytes,
      vcpu: snapshot.vcpu,
      memoryBytes: snapshot.memoryBytes,
      region: snapshot.region,
    },
  };
}

interface Collected {
  text: string;
  callbackError?: unknown;
}

/** Reads one output queue into `out`, handing each chunk to `onChunk` as it arrives. */
async function streamOutput(
  queue: AsyncIterable<Uint8Array>,
  onChunk: ((data: string) => void) | undefined,
  out: Collected,
): Promise<void> {
  const decoder = new TextDecoder();
  const emit = (chunk: string) => {
    if (!chunk) return;
    out.text += chunk;
    if (!onChunk || out.callbackError !== undefined) return;
    try {
      onChunk(chunk);
    } catch (err) {
      // The first callback error is thrown once the command is done; the output keeps coming.
      out.callbackError = err;
    }
  };
  try {
    for await (const bytes of queue) emit(decoder.decode(bytes, { stream: true }));
  } catch {
    // The queue fails when the stream is closed; what arrived before that is kept.
  }
  emit(decoder.decode());
}

async function streamOnce(instance: BoxdInstance, command: string, options: RunCommandOptions): Promise<CommandResult> {
  const start = Date.now();
  const stream = instance.client.machines.streamExec(instance.id, {
    command: shellCommand(command, options),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    closeStdin: true,
    ...regionOpt(instance.region),
  });
  const stdout: Collected = { text: '' };
  const stderr: Collected = { text: '' };
  const outputs = Promise.all([
    streamOutput(stream.stdout, options.onStdout, stdout),
    streamOutput(stream.stderr, options.onStderr, stderr),
  ]);
  const waiting = stream.wait();
  waiting.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    if (options.timeout) timer = setTimeout(() => resolve('timeout'), options.timeout);
  });
  let exitCode: number;
  try {
    const first = await Promise.race([waiting, deadline]);
    if (first === 'timeout') {
      // boxd kills the command when its stream closes; report it the way `timeout(1)` does.
      stream.close();
      exitCode = TIMEOUT_EXIT_CODE;
      // A stream closed before it connected never ends its queues, so don't wait on them long.
      await within(outputs.then(() => undefined), STREAM_CLOSE_GRACE_MS, undefined);
    } else {
      exitCode = first;
      await outputs;
    }
  } catch (err) {
    stream.close();
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const callbackError = stdout.callbackError ?? stderr.callbackError;
  if (callbackError !== undefined) throw callbackError;
  return { stdout: stdout.text, stderr: stderr.text, exitCode, durationMs: Date.now() - start };
}

async function probeUrl(domain: string): Promise<'live' | 'pending' | 'untrusted'> {
  try {
    const res = await fetch(`https://${domain}${READY_PATH}`, { signal: AbortSignal.timeout(5000) });
    await res.body?.cancel().catch(() => undefined);
    const marker = res.headers.get('x-boxd-proxy');
    // `ready`: boxd's proxy has the route. No marker: an older proxy passed it to the app, so the URL works too.
    return marker === null || marker === 'ready' ? 'live' : 'pending';
  } catch (err) {
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    return code && UNTRUSTED_CERT_CODES.has(code) ? 'untrusted' : 'pending';
  }
}

/**
 * Waits until a port URL answers over HTTPS. A computer's first URL waits for the computer's
 * certificate (about 20 s); once one URL answers, a later one needs only its route.
 */
async function untilLive(instance: BoxdInstance, domain: string): Promise<void> {
  const limit = urlTimeouts.get(instance) ?? URL_READY_TIMEOUT_MS;
  const live = liveUrls.get(instance.id);
  if (limit <= 0 || live?.has(domain) || typeof fetch !== 'function') return;
  const deadline = Date.now() + (live ? Math.min(limit, URL_ROUTE_TIMEOUT_MS) : limit);
  for (;;) {
    const probe = await probeUrl(domain);
    if (probe === 'live') {
      liveUrls.set(instance.id, (live ?? new Set<string>()).add(domain));
      return;
    }
    if (probe === 'untrusted' || Date.now() >= deadline) return;
    await sleep(500);
  }
}

export const boxd = defineProvider<BoxdInstance, BoxdConfig, unknown, Snapshot, BoxdVolume>({
  name: 'boxd',
  // boxd gives every vCPU 4 GiB of memory and the standard classes give 1 or 2, so no
  // class is an exact match and the resolver says so instead of rounding.
  sizes: () => ({
    status: 'unsupported',
    reason: `boxd computers come in ${SIZE_LIST}; none equals a standard size class. Pass vcpus or memoryMiB instead.`,
  }),
  methods: {
    instances: {
      create: async (config: BoxdConfig, options: CreateInstanceOptions = {}) => {
        const resolved = resolveConfig(config);
        const client = clientFor(resolved);
        const envs = stringEnvs(options.envs);
        const mounts = await resolveMounts(client, resolved, options);
        const machine = await createMachine(client, resolved, createParams(resolved, options, mounts));
        remember(machine);
        createdHere.set(machine.id, Date.now());
        hasDisks.set(machine.id, mounts.volumes.length > 0);
        const instance = toInstance(client, resolved, machine, envs);
        try {
          // create returns before the computer takes commands; waitUntilReady covers the gap.
          instance.machine = await onComputer(client, resolved.org, instance, () =>
            client.machines.waitUntilReady(machine.id, regionOpt(instance.region)),
          );
          if (mounts.volumes.length > 0) await checkMounts(instance, mounts.volumes);
          if (Object.keys(envs).length > 0) await writeEnvFile(instance, envs);
        } catch (err) {
          await deleteComputer(client, resolved.org, instance).catch((cleanup: Error) => {
            throw new Error(
              `boxd computer ${machine.name} (${machine.id}) failed to start (${(err as Error).message}) ` +
                `and could not be deleted (${cleanup.message}). Delete it with \`boxd machine destroy ${machine.name}\`.`,
            );
          });
          throw err;
        }
        return { instance, instanceId: machine.id };
      },

      getById: async (config: BoxdConfig, instanceId: string) => {
        const resolved = resolveConfig(config);
        const client = clientFor(resolved);
        const target = { id: instanceId, region: regionOf.get(instanceId) ?? resolved.region };
        try {
          const machine = await onComputer(client, resolved.org, target, () => client.machines.get(instanceId, regionOpt(target.region)));
          remember(machine);
          return { instance: toInstance(client, resolved, machine), instanceId: machine.id };
        } catch (err) {
          if (err instanceof NotFoundError) return null;
          throw err;
        }
      },

      // Only the computers this provider created, which carry the computesdk label, in
      // every region the org has unless the config names one.
      list: async (config: BoxdConfig) => {
        const resolved = resolveConfig(config);
        const client = clientFor(resolved);
        const machines = await client.machines.list({
          ...(resolved.org ? { org: resolved.org } : {}),
          region: resolved.region ?? 'all',
          labels: { ...LABEL },
        });
        machines.forEach(remember);
        return machines.map((machine) => ({ instance: toInstance(client, resolved, machine), instanceId: machine.id }));
      },

      destroy: async (config: BoxdConfig, instanceId: string) => {
        const resolved = resolveConfig(config);
        await deleteComputer(clientFor(resolved), resolved.org, { id: instanceId, region: regionOf.get(instanceId) ?? resolved.region });
      },

      runCommand: async (instance: BoxdInstance, command: string, options: RunCommandOptions = {}): Promise<CommandResult> => {
        // A command with a timeout runs over the exec stream, which keeps what it printed before boxd stopped it.
        if (options.timeout && !options.background) {
          return onInstance(instance, () => streamOnce(instance, command, options), { start: true });
        }
        const start = Date.now();
        const result = await onInstance(
          instance,
          () =>
            instance.client.machines.exec(instance.id, {
              command: shellCommand(command, options),
              ...(options.cwd ? { cwd: options.cwd } : {}),
              ...regionOpt(instance.region),
            }),
          { start: true },
        );
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, durationMs: Date.now() - start };
      },

      // Output arrives over boxd's own exec stream, so no port has to be exposed for it.
      streamCommand: async (instance: BoxdInstance, command: string, options: RunCommandOptions): Promise<CommandResult> => {
        let delivered = false;
        const tracked: RunCommandOptions = {
          ...options,
          onStdout: (data) => {
            delivered = true;
            options.onStdout?.(data);
          },
          onStderr: (data) => {
            delivered = true;
            options.onStderr?.(data);
          },
        };
        // Made again (on a stopped computer, or a "not found") only while nothing has been delivered.
        return onInstance(instance, () => streamOnce(instance, command, tracked), { start: true, canRetry: () => !delivered });
      },

      getInfo: async (instance: BoxdInstance): Promise<InstanceInfo> => {
        let machine: Machine | undefined;
        try {
          machine = await onComputer(instance.client, instance.org, instance, () =>
            instance.client.machines.get(instance.id, regionOpt(instance.region)),
          );
          instance.machine = machine;
        } catch (err) {
          if (!(err instanceof NotFoundError)) throw err;
        }
        const current = machine ?? instance.machine;
        return {
          id: instance.id,
          provider: 'boxd',
          status: machine ? infoStatus(machine.status) : 'stopped',
          createdAt: current.createdAt ?? new Date(0),
          timeout: current.deleteAt ? Math.max(0, current.deleteAt.getTime() - Date.now()) : 0,
          metadata: {
            name: current.name,
            status: machine ? machine.status : 'destroyed',
            region: current.region,
            org: current.org?.name,
            resources: current.resources,
            bootTimeMs: current.bootTimeMs,
            labels: current.labels,
          },
        };
      },

      // A named route per port: https://p<port>.<computer>.<zone>. The computer's default
      // domain sits behind bot protection, so it is not handed out. The URL is returned once
      // it answers (see `untilLive`).
      getUrl: async (instance: BoxdInstance, options: { port: number; protocol?: string }): Promise<string> => {
        if (options.port === DAEMON_EVENTS_PORT) {
          // ComputeSDK asks for this port to stream its process daemon's events. A public URL
          // would expose the daemon and wait for a certificate, so the factory is told no and
          // polls the daemon over exec instead.
          throw new Error(`boxd gives ComputeSDK's process daemon (port ${DAEMON_EVENTS_PORT}) no public URL; its output is polled instead`);
        }
        const proxies = instance.client.machines.proxies;
        const call = <T>(fn: () => Promise<T>) => onComputer(instance.client, instance.org, instance, fn);
        const routeFor = async () =>
          (await call(() => proxies.list(instance.id, regionOpt(instance.region)))).find(
            (p) => p.name && !p.isDefault && p.port === options.port,
          )?.domain;
        let domain = await routeFor();
        if (!domain) {
          try {
            await call(() => proxies.create(instance.id, proxyName(options.port), options.port, regionOpt(instance.region)));
          } catch (err) {
            // A getUrl running at the same time may have made it first.
            if (!(err instanceof ConflictError)) throw err;
          }
          domain = await routeFor();
          if (!domain) throw new Error(`boxd made no route for port ${options.port} on computer ${instance.name}`);
        }
        await untilLive(instance, domain);
        const scheme = options.protocol === 'ws' || options.protocol === 'wss' ? 'wss' : 'https';
        return `${scheme}://${domain}`;
      },

      getInstance: (instance: BoxdInstance): BoxdInstance => instance,

      // Adds a volume to a computer. A disk lives on one host, so this works when the computer
      // runs there; `create({ volumes })` places a new computer next to its disks. boxd mounts a
      // computer's disks when it boots, so a running computer is restarted for the volume to appear.
      attachVolume: async (instance: BoxdInstance, volume: string | Volume, mountPath: string): Promise<void> => {
        const disk = await requireDisk(instance.client, instance.region, volume);
        try {
          await onComputer(instance.client, instance.org, instance, () =>
            instance.client.disks.attach(disk.id, instance.id, mountPath, regionOpt(instance.region)),
          );
        } catch (err) {
          if (err instanceof BoxdError && /alongside the disk|is on worker/i.test(err.message)) {
            // The factory retries an attach whose error reads like a disk still in use
            // elsewhere, so this one keeps clear of those words.
            throw new Error(
              `boxd keeps volume ${disk.name} on the host it was made on, and computer ${instance.name} runs on another one. ` +
                `Pass it in create({ volumes }) so boxd places the computer next to it.`,
            );
          }
          throw err;
        }
        hasDisks.set(instance.id, true);
        const machine = await instance.client.machines.get(instance.id, regionOpt(instance.region));
        if (machine.status === 'stopped') return;
        await restartAround(instance, async () => undefined);
        if ((await missingMounts(instance, [mountPath])).length === 0) return;
        // A computer can boot before its host has taken the new disk; the next boot has it.
        await restartAround(instance, async () => undefined);
        await checkMounts(instance, [{ mountPath, readOnly: false }]);
      },

      // boxd lets go of a disk only once the guest has, so a running computer is stopped
      // cleanly, the disk detached, and the computer started again.
      detachVolume: async (instance: BoxdInstance, volume: string | Volume): Promise<void> => {
        const disk = await requireDisk(instance.client, instance.region, volume);
        if (!disk.attachments.some((a) => a.machineId === instance.id)) return;
        const region = regionOpt(instance.region);
        try {
          await instance.client.disks.detach(disk.id, instance.id, region);
        } catch (err) {
          if (!(err instanceof ConflictError) || !/stop it/i.test(err.message)) throw err;
          await restartAround(instance, () => instance.client.disks.detach(disk.id, instance.id, region));
        }
      },

      // boxd's file API, so no shell is involved. Files are written as the computer's user,
      // `boxd`, and a relative path starts in its home directory.
      filesystem: {
        readFile: async (instance: BoxdInstance, path: string): Promise<string> => {
          const bytes = await onInstance(instance, () => instance.client.machines.fs.read(instance.id, path, regionOpt(instance.region)));
          return new TextDecoder().decode(bytes);
        },
        writeFile: async (instance: BoxdInstance, path: string, content: string): Promise<void> => {
          await onInstance(instance, () => instance.client.machines.fs.write(instance.id, path, content, regionOpt(instance.region)));
        },
        mkdir: async (instance: BoxdInstance, path: string): Promise<void> => {
          try {
            await onInstance(instance, () => instance.client.machines.fs.mkdir(instance.id, path, regionOpt(instance.region)));
          } catch (err) {
            if (!(err instanceof MachineFileExistsError)) throw err;
            const stat = await onInstance(instance, () => instance.client.machines.fs.stat(instance.id, path, regionOpt(instance.region)));
            if (!stat.isDir) throw err;
          }
        },
        readdir: async (instance: BoxdInstance, path: string): Promise<FileEntry[]> => {
          const entries = await onInstance(instance, () => instance.client.machines.fs.list(instance.id, path, regionOpt(instance.region)));
          return entries.map((entry) => ({
            name: entry.name,
            type: entry.isDir ? ('directory' as const) : ('file' as const),
            size: entry.size,
            modified: entry.mtime,
          }));
        },
        exists: async (instance: BoxdInstance, path: string): Promise<boolean> => {
          return onInstance(instance, () => instance.client.machines.fs.exists(instance.id, path, regionOpt(instance.region)));
        },
        remove: async (instance: BoxdInstance, path: string): Promise<void> => {
          // Removal is recursive and a relative path starts in the home directory, so a path
          // that names the home directory, its parent or the root is refused.
          if (/^[./~]*$/.test(path.trim())) throw new Error(`Refusing to remove ${JSON.stringify(path)}: name a path inside the computer`);
          try {
            await onInstance(instance, () =>
              instance.client.machines.fs.remove(instance.id, path, { recursive: true, ...regionOpt(instance.region) }),
            );
          } catch (err) {
            if (!(err instanceof MachineFileNotFoundError)) throw err;
          }
        },
      },
    },

    // A snapshot is the computer's disk and memory, captured once. Create a computer from
    // it with `create({ snapshotId })`; it starts as it was captured, already running.
    snapshot: {
      create: async (config: BoxdConfig, instanceId: string, options?: CreateSnapshotOptions): Promise<Snapshot> => {
        const resolved = resolveConfig(config);
        const client = clientFor(resolved);
        const name = options?.name || `${SNAPSHOT_PREFIX}${instanceId.slice(0, 8)}-${randomSuffix().slice(0, 6)}`;
        const target = { id: instanceId, region: regionOf.get(instanceId) ?? resolved.region };
        const created = await onComputer(client, resolved.org, target, () =>
          client.snapshots.create(instanceId, name, regionOpt(target.region)),
        );
        // The snapshot is kept in its computer's region. Saving under a name that exists
        // captures a new version, and `get` shows the latest ready one, so this waits for it.
        const lookup = { ...(resolved.org ? { org: resolved.org } : {}), ...regionOpt(target.region) };
        const deadline = Date.now() + SNAPSHOT_READY_TIMEOUT_MS;
        for (;;) {
          const snapshot = await client.snapshots.get(created.name, lookup);
          if (snapshot.status === 'ready' && (snapshot.version ?? 0) >= created.version) return toSnapshot(snapshot);
          if (snapshot.status === 'failed' || Date.now() >= deadline) {
            const why = snapshot.status === 'failed' ? 'failed' : `not ready after ${SNAPSHOT_READY_TIMEOUT_MS / 1000} s`;
            throw new Error(`boxd snapshot ${created.name} (${created.id}) version ${created.version} ${why}`);
          }
          await sleep(500);
        }
      },

      // Every region the org has, unless the config names one. boxd doesn't link a snapshot
      // to the computer it was taken from; the names this provider gives carry the computer's
      // id, so filtering by `instanceId` returns those.
      list: async (config: BoxdConfig, options?: ListSnapshotsOptions): Promise<Snapshot[]> => {
        const resolved = resolveConfig(config);
        const snapshots = await clientFor(resolved).snapshots.list({
          ...(resolved.org ? { org: resolved.org } : {}),
          region: resolved.region ?? 'all',
        });
        const instanceId = options?.instanceId ?? options?.sandboxId;
        const prefix = instanceId ? `${SNAPSHOT_PREFIX}${instanceId.slice(0, 8)}-` : undefined;
        const all = snapshots.filter((s) => !prefix || s.name.startsWith(prefix)).map(toSnapshot);
        return options?.limit ? all.slice(0, options.limit) : all;
      },

      delete: async (config: BoxdConfig, snapshotId: string): Promise<void> => {
        const resolved = resolveConfig(config);
        const client = clientFor(resolved);
        const remove = (region?: string) =>
          client.snapshots.delete(snapshotId, { ...(resolved.org ? { org: resolved.org } : {}), ...regionOpt(region) });
        try {
          await remove(resolved.region);
        } catch (err) {
          if (!(err instanceof NotFoundError)) throw err;
          // A snapshot is kept in its computer's region, which need not be the configured one.
          const region = await locateSnapshot(client, resolved.org, snapshotId).catch(() => undefined);
          if (!region || region === resolved.region) return;
          try {
            await remove(region);
          } catch (again) {
            if (!(again instanceof NotFoundError)) throw again;
          }
        }
      },
    },

    // Volumes are boxd disks: persistent, formatted ext4, mounted on one computer at a time.
    volume: {
      create: async (config: BoxdConfig, options: CreateVolumeOptions): Promise<BoxdVolume> => {
        const resolved = resolveConfig(config);
        const client = clientFor(resolved);
        const created = await client.disks.create(options.name, options.sizeBytes ?? DEFAULT_VOLUME_BYTES, regionOpt(resolved.region));
        // A disk can be mounted once it is formatted, about a second after it is made.
        return toVolume(await readyDisk(client, created.id, resolved.region));
      },

      get: async (config: BoxdConfig, volumeIdOrName: string): Promise<BoxdVolume | null> => {
        const resolved = resolveConfig(config);
        const disk = await findDisk(clientFor(resolved), resolved.region, volumeIdOrName);
        return disk ? toVolume(disk) : null;
      },

      list: async (config: BoxdConfig, options?: ListVolumesOptions): Promise<BoxdVolume[]> => {
        const resolved = resolveConfig(config);
        const disks = await clientFor(resolved).disks.list({ region: resolved.region ?? 'all' });
        const all = disks.map(toVolume);
        return options?.limit ? all.slice(0, options.limit) : all;
      },

      delete: async (config: BoxdConfig, volumeIdOrName: string): Promise<void> => {
        const resolved = resolveConfig(config);
        const client = clientFor(resolved);
        const disk = await findDisk(client, resolved.region, volumeIdOrName);
        if (!disk) return;
        try {
          await client.disks.delete(disk.id, regionOpt(disk.region));
        } catch (err) {
          if (!(err instanceof NotFoundError)) throw err;
        }
      },
    },
  },
});

export default boxd;
