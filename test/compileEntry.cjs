const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

/**
 * Run the authored TypeScript in a controlled browser context.
 * External source maps let V8 coverage report against the original files.
 * @param {string} relativePath
 * @param {vm.Context} context
 * @returns {unknown}
 */
function runEntry(relativePath, context) {
  const source = path.resolve(relativePath);
  const output = path.resolve('.coverage-compiled', relativePath.replace(/\.ts$/, '.js'));
  const directory = path.dirname(output);
  const transpiled = ts.transpileModule(readFileSync(source, 'utf8'), {
    fileName: source,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      sourceMap: true,
      inlineSources: true,
      esModuleInterop: true,
    },
  });
  const map = JSON.parse(transpiled.sourceMapText);
  map.sources = [path.relative(directory, source).split(path.sep).join('/')];
  mkdirSync(directory, { recursive: true });
  writeFileSync(output, transpiled.outputText);
  writeFileSync(output + '.map', JSON.stringify(map));

  context.exports = {};
  new vm.Script(transpiled.outputText, { filename: output }).runInContext(context);
  return context.exports.default;
}

module.exports = { runEntry };
