export const FIXTURE_PROTOCOL_VERSION = 1;
const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const pid = (value) => Number.isSafeInteger(value) && value > 1;
const envelope = (value, nonce) =>
  record(value) &&
  value.version === FIXTURE_PROTOCOL_VERSION &&
  value.nonce === nonce;
const identity = (value) =>
  record(value) &&
  pid(value.pid) &&
  Number.isSafeInteger(value.parent) &&
  value.parent >= 0 &&
  pid(value.group) &&
  typeof value.state === 'string' &&
  value.state.length > 0 &&
  typeof value.started === 'string' &&
  value.started.trim().length > 0;
const errorFields = [
  'name',
  'message',
  'stack',
  'code',
  'errno',
  'syscall',
  'path',
  'spawnargs',
];

export function serializeFixtureError(value) {
  const source =
    value instanceof Error || record(value) ? value : new Error(String(value));
  const error = {
    name: typeof source.name === 'string' ? source.name : 'Error',
    message:
      typeof source.message === 'string' ? source.message : String(value),
  };
  for (const field of errorFields.slice(2)) {
    if (source[field] !== undefined) error[field] = source[field];
  }
  return error;
}
function error(value) {
  return (
    record(value) &&
    typeof value.name === 'string' &&
    typeof value.message === 'string' &&
    ['stack', 'code', 'syscall', 'path'].every(
      (field) => value[field] === undefined || typeof value[field] === 'string'
    ) &&
    (value.errno === undefined ||
      typeof value.errno === 'number' ||
      typeof value.errno === 'string') &&
    (value.spawnargs === undefined || strings(value.spawnargs))
  );
}
export function restoreFixtureError(value) {
  const result = new Error(value.message);
  for (const field of errorFields)
    if (value[field] !== undefined) result[field] = value[field];
  return result;
}
export function readSupervisorMessage(value, nonce) {
  if (!envelope(value, nonce)) return undefined;
  if (
    (value.type === 'owned' || value.type === 'workload') &&
    identity(value.identity)
  )
    return value;
  if (value.type === 'retired') return value;
  if (
    value.type === 'target-exit' &&
    (value.status === null || Number.isSafeInteger(value.status)) &&
    (value.signal === null ||
      (typeof value.signal === 'string' &&
        /^SIG[A-Z0-9]+$/.test(value.signal))) &&
    (value.status !== null || value.signal !== null)
  )
    return value;
  if (value.type === 'spawn-failed' && error(value.error)) return value;
  if (
    value.type === 'inspection-failed' &&
    ['self', 'workload'].includes(value.stage) &&
    error(value.error)
  )
    return value;
  if (value.type === 'protocol-failed' && error(value.error)) return value;
  return undefined;
}
export function readSupervisorControl(value, nonce) {
  if (!envelope(value, nonce)) return undefined;
  if (value.type === 'retire') return value;
  if (
    value.type === 'start' &&
    typeof value.command === 'string' &&
    strings(value.args) &&
    typeof value.cwd === 'string' &&
    record(value.env) &&
    Object.values(value.env).every((item) => typeof item === 'string')
  )
    return value;
  return undefined;
}
