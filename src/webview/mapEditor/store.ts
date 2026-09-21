/**
 * Map-editor state store - webview-side re-export.
 *
 * The store itself lives in `src/rom/model/stores/editorStore.ts` so model
 * behaviors can import it without crossing the webview boundary. The webview
 * imports the singleton from here for ergonomics; existing call sites keep
 * working unchanged.
 *
 *   import { editorStore as store } from './store'
 *
 * Mutation always flows through actions on the store (e.g. `store.setZoom(z)`),
 * preserving the equality guards that prevent spurious re-renders.
 */

export { editorStore, createEditorStore } from '../../rom/model/stores/editorStore'
export type { EditorStore } from '../../rom/model/stores/editorStore'
