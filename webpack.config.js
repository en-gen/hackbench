/* eslint-disable @typescript-eslint/no-var-requires */
'use strict'

const path = require('path')

/**
 * Two webpack targets:
 *  1. extension  — the extension host code (Node.js, externalises vscode)
 *  2. levelEditor — the level editor webview (browser)
 *
 * Run `npm run compile` to build both.
 * Run `npm run watch` during development.
 */

/** @type {import('webpack').Configuration} */
const extensionConfig = {
  target: 'node',
  mode: 'none',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: 'ts-loader'
      }
    ]
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: { level: 'log' }
}

/** @type {import('webpack').Configuration} */
const levelEditorWebviewConfig = {
  target: 'web',
  mode: 'none',
  entry: './src/webview/levelEditor/main.ts',
  output: {
    path: path.resolve(__dirname, 'dist/webview'),
    filename: 'levelEditor.js'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          options: { configFile: 'tsconfig.webview.json' }
        }
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader']
      }
    ]
  },
  devtool: 'nosources-source-map'
}

/** @type {import('webpack').Configuration} */
const paletteEditorWebviewConfig = {
  target: 'web',
  mode: 'none',
  entry: './src/webview/paletteEditor/main.ts',
  output: {
    path: path.resolve(__dirname, 'dist/webview'),
    filename: 'paletteEditor.js'
  },
  resolve: { extensions: ['.ts', '.js'] },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: { loader: 'ts-loader', options: { configFile: 'tsconfig.webview.json' } }
      }
    ]
  },
  devtool: 'nosources-source-map'
}

/** @type {import('webpack').Configuration} */
const gfxViewerWebviewConfig = {
  target: 'web',
  mode: 'none',
  entry: './src/webview/gfxViewer/main.ts',
  output: {
    path: path.resolve(__dirname, 'dist/webview'),
    filename: 'gfxViewer.js'
  },
  resolve: { extensions: ['.ts', '.js'] },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: { loader: 'ts-loader', options: { configFile: 'tsconfig.webview.json' } }
      }
    ]
  },
  devtool: 'nosources-source-map'
}

module.exports = [extensionConfig, levelEditorWebviewConfig, paletteEditorWebviewConfig, gfxViewerWebviewConfig]
