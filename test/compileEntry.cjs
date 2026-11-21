const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

/**
 * Run the authored TypeScript and its local imports in a controlled browser context.
 * External source maps let V8 coverage report against the original files.
 * @param {string} relativePath
 * @param {vm.Context} context
 * @returns {unknown}
 */
function runEntry(relativePath, context) {
  const modules = new Map();
  const hostRequire = context.require || require;

  function load(source) {
    if (modules.has(source)) return modules.get(source);
    const output = path.resolve(
      '.coverage-compiled',
      path.relative(process.cwd(), source).replace(/\.ts$/, '.js'),
    );
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

    const exports = {};
    modules.set(source, exports);
    const requireModule = (specifier) => {
      if (specifier.startsWith('.')) {
        const dependency = path.resolve(path.dirname(source), specifier + '.ts');
        if (existsSync(dependency)) return load(dependency);
      }
      return hostRequire(specifier);
    };
    // Apply the module wrapper without shifting the authored source-map line numbers.
    const compiled = new vm.Script(`(function(exports, require) {${transpiled.outputText}\n})`, {
      filename: output,
    });
    compiled.runInContext(context)(exports, requireModule);
    return exports;
  }

  context.exports = load(path.resolve(relativePath));
  return context.exports.default ?? context.exports;
}

module.exports = { runEntry };
