import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createEditorStorage } from '../examples/utils/editorStorage.js';
import { FileUploadManager } from '../examples/utils/FileUploadManager.js';
import { readStoredScene, forgetStoredScene, resolveInitialScene, DEFAULT_SCENE } from '../examples/utils/initialScene.js';

function dom() {
    const { document } = parseHTML('<html><body></body></html>');
    globalThis.document = document;
    return document;
}

test('boot tolerates a throwing browser storage getter and selects the bundled scene', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
    try {
        assert.equal(resolveInitialScene(readStoredScene()), DEFAULT_SCENE);
        assert.doesNotThrow(() => forgetStoredScene());
    } finally {
        if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
        else delete globalThis.localStorage;
    }
});

test('blocked storage accessor preserves editing in memory and warns once', () => {
    let warnings = 0;
    const storage = createEditorStorage(() => { throw new Error('Storage blocked'); }, () => warnings++);
    assert.equal(storage.getItem('script'), null);
    storage.setItem('script', 'print(1)');
    storage.setItem('script', 'print(2)');
    assert.equal(storage.getItem('script'), 'print(2)');
    assert.equal(warnings, 1);
});

test('quota failures keep the newest script instead of returning the stale saved copy', () => {
    const storage = createEditorStorage(() => ({
        getItem: () => 'old script', setItem: () => { throw new Error('Quota exceeded'); },
    }));
    assert.equal(storage.getItem('script'), 'old script');
    storage.setItem('script', 'new script');
    assert.equal(storage.getItem('script'), 'new script');
});

test('available storage persists and restores script contents', () => {
    const values = new Map();
    const getStorage = () => ({ getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v) });
    createEditorStorage(getStorage).setItem('script', 'saved');
    assert.equal(createEditorStorage(getStorage).getItem('script'), 'saved');
});

test('required filenames render as literal text with a useful completion count', () => {
    const document = dom();
    const manager = new FileUploadManager({}, {});
    manager.ensureDialog();
    const info = { includes: new Set(['parts/<part>.xml']), assets: new Set(), loadedFiles: new Set() };
    manager.refreshRequiredFilesUI(info);
    const list = document.getElementById('required-files');
    assert.match(list.textContent, /0\/1 ready/);
    assert.match(list.textContent, /parts\/<part>\.xml/);
    assert.equal(list.querySelector('part'), null);
    assert.equal(document.getElementById('load-robot-btn').disabled, true);
    info.loadedFiles.add('custom_scenes/test/parts/<part>.xml');
    manager.refreshRequiredFilesUI(info);
    assert.match(list.textContent, /1\/1 ready/);
    assert.equal(document.getElementById('load-robot-btn').disabled, false);
});

test('nested asset destinations remain inside the selected scene', () => {
    const manager = new FileUploadManager({}, {});
    manager.currentUploadPath = 'custom_scenes/test';
    const info = { includes: new Set(['parts/arm.xml']), assets: new Set(['meshes/arm.obj']) };
    assert.equal(manager.resolveDestinationPath('arm.obj', info), '/working/custom_scenes/test/meshes/arm.obj');
    assert.equal(manager.resolveDestinationPath('arm.xml', info), '/working/custom_scenes/test/parts/arm.xml');
});

test('failed compile keeps previous scene selected and leaves modal open with a retry message', async () => {
    const document = dom();
    const context = {
        params: { scene: 'previous.xml' },
        reloadScene: async path => {
            assert.equal(path, 'custom_scenes/test/scene.xml');
            throw new Error('Invalid model');
        },
        parentBridge: { _ensureSceneOption: () => assert.fail('must not select a failed scene'), emitDirty: () => assert.fail('must not save a failed scene') },
    };
    const manager = new FileUploadManager({}, context);
    manager.openDialog();
    manager.currentUploadPath = 'custom_scenes/test';
    manager.uploadedFiles.set('test', { xmlPath: 'custom_scenes/test/scene.xml', robotName: 'Test' });
    const button = document.getElementById('load-robot-btn');
    button.disabled = false;
    button.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.params.scene, 'previous.xml');
    assert.equal(document.getElementById('upload-dialog').style.display, 'flex');
    assert.match(document.getElementById('xml-status').textContent, /Invalid model.*retry/);
    assert.equal(button.disabled, false);
});

test('successful compile selects the uploaded scene and closes the modal', async () => {
    const document = dom();
    const events = [];
    const context = {
        reloadScene: async path => events.push(['compile', path]),
        parentBridge: { _ensureSceneOption: (name, path) => events.push(['select', name, path]), emitDirty: reason => events.push(['dirty', reason]) },
    };
    const manager = new FileUploadManager({}, context);
    manager.openDialog();
    manager.currentUploadPath = 'custom_scenes/test';
    manager.uploadedFiles.set('test', { xmlPath: 'custom_scenes/test/scene.xml', robotName: 'Test' });
    const button = document.getElementById('load-robot-btn');
    button.disabled = false;
    button.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, [ ['compile', 'custom_scenes/test/scene.xml'], ['select', 'Test', 'custom_scenes/test/scene.xml'], ['dirty', 'assets'] ]);
    assert.equal(document.getElementById('upload-dialog').style.display, 'none');
});
