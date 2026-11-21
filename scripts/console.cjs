/**
 * Keep the same severity prefix across interactive release steps and CI logs.
 * @param {'info' | 'error'} level
 * @param {...unknown} args
 */
function report(level, ...args) {
  const error = level === 'error';
  const stream = error ? process.stderr : process.stdout;
  const { NO_COLOR, FORCE_COLOR } = process.env;
  const colour =
    NO_COLOR === undefined &&
    (FORCE_COLOR === undefined ? stream.isTTY : FORCE_COLOR !== '0' && FORCE_COLOR !== 'false');
  const label = error ? '[ERROR]' : '[INFO]';
  const prefix = colour ? `\u001b[1;${error ? 31 : 36}m${label}\u001b[0m` : label;
  console[error ? 'error' : 'log'](prefix, ...args);
}

module.exports = { report };
