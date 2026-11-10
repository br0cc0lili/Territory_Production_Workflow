// App Builder action bundling (as recommended by Adobe's FFCPE Custom Node SDK):
// TypeScript/JavaScript sources -> CommonJS bundles for Adobe I/O Runtime.
module.exports = {
  output: {
    libraryTarget: 'commonjs2',
  },
  module: {
    rules: [
      {
        test: /\.[jt]sx?$/,
        loader: 'esbuild-loader',
        options: { target: 'es2020' },
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
}
