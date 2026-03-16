// CodeEditor.js — thin wrapper around CodeMirror 6
// Provides getValue() / setValue() so the rest of the app stays unchanged.

import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';

export function createCodeEditor(hostEl, initialValue = '') {
    const view = new EditorView({
        state: EditorState.create({
            doc: initialValue,
            extensions: [
                lineNumbers(),
                highlightActiveLine(),
                history(),
                python(),
                oneDark,
                keymap.of([...defaultKeymap, ...historyKeymap]),
                EditorView.theme({
                    '&': {
                        fontSize: '13px',
                        height: '100%',
                        background: '#1e1e1e',
                    },
                    '.cm-scroller': { overflow: 'auto', fontFamily: "'Consolas','Monaco','Courier New',monospace" },
                    '.cm-content': { padding: '6px 0' },
                    '.cm-gutters': { background: '#1a1a1a', borderRight: '1px solid #333', color: '#555' },
                }),
                EditorView.lineWrapping,
            ],
        }),
        parent: hostEl,
    });

    return {
        getValue() { return view.state.doc.toString(); },
        setValue(text) {
            view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: text },
            });
        },
        focus() { view.focus(); },
        /** Pass a keydown handler to be called before CodeMirror handles the event. */
        addKeyHandler(fn) {
            view.dom.addEventListener('keydown', fn);
        },
    };
}
