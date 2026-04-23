/* eslint-disable @typescript-eslint/no-var-requires */
'use strict'

const path = require('path')

/**
 * Two webpack targets:
 *  1. extension  — the extension host code (Node.js, externalises vscode)
 *  2. mapEditor — the map editor webview (browser)
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
const mapEditorWebviewConfig = {
  target: 'web',
  mode: 'none',
  entry: './src/webview/mapEditor/main.ts',
  output: {
    path: path.resolve(__dirname, 'dist/webview'),
    filename: 'mapEditor.js'
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
  plugins: [
    // VS Code codicon font + stylesheet, referenced via <link> in the webview HTML.
    new (require('copy-webpack-plugin'))({
      patterns: [
        {
          from: require.resolve('@vscode/codicons/dist/codicon.css'),
          to: path.resolve(__dirname, 'dist/webview/codicon.css')
        },
        {
          from: require.resolve('@vscode/codicons/dist/codicon.ttf'),
          to: path.resolve(__dirname, 'dist/webview/codicon.ttf')
        }
      ]
    })
  ],
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

/** @type {import('webpack').Configuration} */
const musicPlayerWebviewConfig = {
  target: 'web',
  mode: 'none',
  entry: './src/webview/musicPlayer/main.ts',
  output: {
    path: path.resolve(__dirname, 'dist/webview'),
    filename: 'musicPlayer.js'
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
  plugins: [
    // Copy spc.js + spc.wasm from @smwcentral/spc-player to dist/webview
    new (require('copy-webpack-plugin'))({
      patterns: [
        {
          from: path.resolve(__dirname, 'node_modules/@smwcentral/spc-player/dist/spc.wasm'),
          to: path.resolve(__dirname, 'dist/webview/spc.wasm')
        },
        {
          from: path.resolve(__dirname, 'node_modules/@smwcentral/spc-player/dist/spc.js'),
          to: path.resolve(__dirname, 'dist/webview/spc.js')
        }
      ]
    })
  ],
  devtool: 'nosources-source-map'
}

/** @type {import('webpack').Configuration} */
const levelGraphWebviewConfig = {
  target: 'web',
  mode: 'none',
  entry: './src/webview/levelGraph/main.ts',
  output: {
    path: path.resolve(__dirname, 'dist/webview'),
    filename: 'levelGraph.js'
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
const tilesetCompareWebviewConfig = {
  target: 'web',
  mode: 'none',
  entry: './src/webview/tilesetCompare/main.ts',
  output: {
    path: path.resolve(__dirname, 'dist/webview'),
    filename: 'tilesetCompare.js'
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

module.exports = [extensionConfig, mapEditorWebviewConfig, paletteEditorWebviewConfig, gfxViewerWebviewConfig, musicPlayerWebviewConfig, levelGraphWebviewConfig, tilesetCompareWebviewConfig]
