// examples/utils/FileUploadManager.js
import { URDFConverter } from './URDFConverter.js';

export class FileUploadManager {
    constructor(mujoco, parentContext) {
      this.mujoco = mujoco;
      this.parentContext = parentContext;
      this.uploadedFiles = new Map();
      this.currentUploadPath = null;
    }
  
    /** Idempotently appends the themed upload modal to <body>. */
    ensureDialog() {
      if (document.getElementById('upload-dialog')) return;

      // Hidden file inputs
      const xmlInput = document.createElement('input');
      xmlInput.type = 'file';
      xmlInput.accept = '.xml,.urdf,.zip';
      xmlInput.style.display = 'none';
      document.body.appendChild(xmlInput);

      const assetsInput = document.createElement('input');
      assetsInput.type = 'file';
      assetsInput.accept = '.xml,.urdf,.stl,.obj,.png,.jpg,.jpeg';
      assetsInput.multiple = true;
      assetsInput.style.display = 'none';
      document.body.appendChild(assetsInput);

      // Modal markup
      const uploadDialog = document.createElement('div');
      uploadDialog.id = 'upload-dialog';
      uploadDialog.className = 'upload-modal';
      uploadDialog.style.display = 'none';
      uploadDialog.innerHTML = `
        <div class="upload-modal-panel">
          <div class="upload-modal-header">
            <span class="upload-modal-title">Upload Custom Robot (URDF / MJCF / ZIP)</span>
            <button type="button" id="cancel-upload-btn" class="upload-modal-close" aria-label="Close">✕</button>
          </div>
          <div class="upload-modal-body">
            <div id="upload-dropzone" class="upload-dropzone">
              <div class="dropzone-icon">📁</div>
              <div class="dropzone-text"><strong>Drag & Drop ZIP package, URDF, or MJCF file here</strong></div>
              <div class="dropzone-sub">Supports .zip (with meshes), .urdf, or .xml models</div>
              <button type="button" id="select-xml-btn" class="ide-button save" style="margin-top: 10px;">Select File</button>
            </div>
            <div id="xml-status" class="upload-modal-status"></div>
            
            <div class="upload-modal-step" style="margin-top: 12px;">
              <div class="upload-modal-step-label"><strong>Additional Assets</strong> (Optional if using ZIP)</div>
              <div id="required-files" class="upload-modal-required" style="display:none"></div>
              <button type="button" id="select-assets-btn" class="ide-button save" disabled>Select Asset Files</button>
              <div id="assets-status" class="upload-modal-status"></div>
            </div>
          </div>
          <div class="upload-modal-footer">
            <button type="button" id="cancel-upload-btn-secondary" class="ide-button save">Cancel</button>
            <button type="button" id="load-robot-btn" class="ide-button run" disabled>Load Robot</button>
          </div>
        </div>
      `;
      document.body.appendChild(uploadDialog);

      const closeModal = () => {
        uploadDialog.style.display = 'none';
        this.resetUploadState();
      };
      document.getElementById('cancel-upload-btn').addEventListener('click', closeModal);
      document.getElementById('cancel-upload-btn-secondary').addEventListener('click', closeModal);

      uploadDialog.addEventListener('click', (e) => {
        if (e.target === uploadDialog) closeModal();
      });

      const dropzone = document.getElementById('upload-dropzone');
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
      dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
      });
      dropzone.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
          const mainFile = files.find(f => f.name.endsWith('.zip') || f.name.endsWith('.urdf') || f.name.endsWith('.xml')) || files[0];
          await this.handleMainFileUpload(mainFile);
        }
      });

      document.getElementById('select-xml-btn').addEventListener('click', () => xmlInput.click());
      document.getElementById('select-assets-btn').addEventListener('click', () => assetsInput.click());

      document.getElementById('load-robot-btn').addEventListener('click', async () => {
        try {
          await this.loadUploadedScene();
        } finally {
          uploadDialog.style.display = 'none';
        }
      });

      xmlInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) await this.handleMainFileUpload(file);
      });

      assetsInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        if (files.length > 0) await this.handleAssetsUpload(files);
      });
    }

    /** Shows the modal in a freshly reset state. */
    openDialog() {
      this.ensureDialog();
      this.resetUploadState();
      const uploadDialog = document.getElementById('upload-dialog');
      if (uploadDialog) uploadDialog.style.display = 'flex';
    }

    async handleMainFileUpload(file) {
      if (file.name.toLowerCase().endsWith('.zip')) {
        await this.handleZipUpload(file);
      } else if (file.name.toLowerCase().endsWith('.urdf')) {
        await this.handleURDFUpload(file);
      } else {
        await this.handleXMLUpload(file);
      }
    }

    async handleZipUpload(file) {
      const xmlStatus = document.getElementById('xml-status');
      xmlStatus.textContent = `Extracting ZIP: ${file.name}...`;
      xmlStatus.style.color = '#3b82f6';

      if (typeof JSZip === 'undefined') {
        xmlStatus.textContent = 'JSZip library not loaded. Please select individual XML/URDF file.';
        xmlStatus.style.color = '#ef4444';
        return;
      }

      try {
        const zip = await JSZip.loadAsync(file);
        const zipName = file.name.replace(/\.zip$/i, '');
        this.currentUploadPath = `custom_scenes/${zipName}`;
        this.createDirectory(`/working/custom_scenes`);
        this.createDirectory(`/working/${this.currentUploadPath}`);
        this.createDirectory(`/working/${this.currentUploadPath}/assets`);

        let mainXmlContent = null;
        let mainXmlFileName = null;

        // Find main scene XML or URDF inside zip
        for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
          if (zipEntry.dir) continue;
          const fileName = relativePath.split('/').pop();
          if (fileName.endsWith('.xml') || fileName.endsWith('.urdf')) {
            if (!mainXmlFileName || fileName === 'scene.xml' || fileName === 'robot.xml' || fileName.endsWith('.urdf')) {
              mainXmlFileName = fileName;
              mainXmlContent = await zipEntry.async('string');
            }
          }
        }

        if (!mainXmlContent) {
          throw new Error('No .xml or .urdf file found in the ZIP package.');
        }

        // Convert URDF if needed
        if (mainXmlFileName.endsWith('.urdf')) {
          const conv = URDFConverter.convert(mainXmlContent, zipName);
          if (conv.errors.length > 0) throw new Error(conv.errors.join('; '));
          mainXmlContent = conv.xml;
        }

        // Auto-rig attachment_site if missing
        mainXmlContent = this.ensureAutoRigging(mainXmlContent);

        // Write main XML
        this.mujoco.FS.writeFile(`/working/${this.currentUploadPath}/scene.xml`, mainXmlContent);

        // Write all other asset files
        let assetCount = 0;
        for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
          if (zipEntry.dir) continue;
          const fileName = relativePath.split('/').pop();
          if (fileName === mainXmlFileName) continue;

          let content;
          if (fileName.match(/\.(png|jpg|jpeg|stl)$/i)) {
            content = await zipEntry.async('uint8array');
          } else {
            content = await zipEntry.async('string');
          }

          const destPath = `/working/${this.currentUploadPath}/assets/${fileName}`;
          this.ensureParentDirectories(destPath);
          this.mujoco.FS.writeFile(destPath, content);
          assetCount++;
        }

        xmlStatus.textContent = `Loaded ZIP package "${zipName}" (${assetCount} assets extracted)`;
        xmlStatus.style.color = '#22c55e';

        this.uploadedFiles.set(zipName, {
          xmlPath: `${this.currentUploadPath}/scene.xml`,
          includes: new Set(),
          assets: new Set(),
          loadedFiles: new Set([`${this.currentUploadPath}/scene.xml`]),
          robotName: zipName
        });

        document.getElementById('load-robot-btn').disabled = false;
      } catch (error) {
        console.error('Error processing ZIP upload:', error);
        xmlStatus.textContent = `ZIP Error: ${error.message}`;
        xmlStatus.style.color = '#ef4444';
      }
    }

    async handleURDFUpload(file) {
      try {
        const xmlStatus = document.getElementById('xml-status');
        xmlStatus.textContent = `Converting URDF: ${file.name}...`;
        xmlStatus.style.color = '#3b82f6';

        const urdfContent = await this.readFileAsText(file);
        const sceneName = file.name.replace(/\.urdf$/i, '');

        const conv = URDFConverter.convert(urdfContent, sceneName);
        if (conv.errors.length > 0) {
          throw new Error(conv.errors.join('; '));
        }

        let mjcfContent = this.ensureAutoRigging(conv.xml);

        this.currentUploadPath = `custom_scenes/${sceneName}`;
        this.createDirectory(`/working/custom_scenes`);
        this.createDirectory(`/working/${this.currentUploadPath}`);
        this.createDirectory(`/working/${this.currentUploadPath}/assets`);

        this.mujoco.FS.writeFile(`/working/${this.currentUploadPath}/scene.xml`, mjcfContent);

        xmlStatus.textContent = `Converted URDF "${conv.robotName}" to MJCF XML!`;
        xmlStatus.style.color = '#22c55e';

        this.uploadedFiles.set(sceneName, {
          xmlPath: `${this.currentUploadPath}/scene.xml`,
          includes: new Set(),
          assets: new Set(conv.meshes),
          loadedFiles: new Set([`${this.currentUploadPath}/scene.xml`]),
          robotName: conv.robotName
        });

        const sceneInfo = this.uploadedFiles.get(sceneName);
        this.refreshRequiredFilesUI(sceneInfo);
        document.getElementById('select-assets-btn').disabled = false;
      } catch (error) {
        console.error('URDF conversion error:', error);
        const xmlStatus = document.getElementById('xml-status');
        xmlStatus.textContent = `URDF Error: ${error.message}`;
        xmlStatus.style.color = '#ef4444';
      }
    }
  
    async handleXMLUpload(file) {
      try {
        const xmlStatus = document.getElementById('xml-status');
        xmlStatus.textContent = `Selected: ${file.name}`;
        xmlStatus.style.color = '#22c55e';
        
        let content = await this.readFileAsText(file);
        content = this.ensureAutoRigging(content);
        
        // Parse XML to find references
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(content, 'text/xml');
        const references = this.extractReferencedFiles(xmlDoc);
        
        // Store upload info
        const sceneName = file.name.replace('.xml', '');
        this.currentUploadPath = `custom_scenes/${sceneName}`;
        
        // Create directories
        this.createDirectory(`/working/custom_scenes`);
        this.createDirectory(`/working/${this.currentUploadPath}`);
        this.createDirectory(`/working/${this.currentUploadPath}/assets`);
        
        // Write scene XML
        this.mujoco.FS.writeFile(`/working/${this.currentUploadPath}/scene.xml`, content);
        
        const mujocoElement = xmlDoc.querySelector('mujoco');
        let robotName = mujocoElement ? mujocoElement.getAttribute('model') : null;
        if (robotName) robotName = robotName.trim();
        if (!robotName) robotName = file.name.replace('.xml', '');

        this.uploadedFiles.set(sceneName, {
          xmlPath: `${this.currentUploadPath}/scene.xml`,
          includes: new Set(references.includes),
          assets: new Set(references.assets),
          loadedFiles: new Set(),
          robotName: robotName
        });

        const sceneInfo = this.uploadedFiles.get(sceneName);
        sceneInfo.loadedFiles.add(`${this.currentUploadPath}/scene.xml`);

        this.refreshRequiredFilesUI(sceneInfo);
        document.getElementById('select-assets-btn').disabled = false;
        
      } catch (error) {
        console.error('Error uploading XML:', error);
        alert(`Error: ${error.message}`);
      }
    }

    /** Auto-rigs attachment_site if missing for Inverse Kinematics */
    ensureAutoRigging(xmlContent) {
      if (xmlContent.includes('name="attachment_site"')) return xmlContent;
      // Append site before closing worldbody or last body
      if (xmlContent.includes('</worldbody>')) {
        return xmlContent.replace('</worldbody>', '    <site name="attachment_site" pos="0.4 0 0.3"/>\n  </worldbody>');
      }
      return xmlContent;
    }
  
    async handleAssetsUpload(files) {
      const sceneName = this.currentUploadPath.split('/')[1];
      const sceneInfo = this.uploadedFiles.get(sceneName);
      const assetsStatus = document.getElementById('assets-status');
      
      for (const file of files) {
        const destination = this.resolveDestinationPath(file.name, sceneInfo) || `/working/${this.currentUploadPath}/assets/${file.name}`;

        let content;
        if (file.name.match(/\.(png|jpg|jpeg|stl)$/i)) {
          content = await this.readFileAsArrayBuffer(file);
          content = new Uint8Array(content);
        } else {
          content = await this.readFileAsText(file);
        }

        this.ensureParentDirectories(destination);
        this.mujoco.FS.writeFile(destination, content);
        sceneInfo.loadedFiles.add(this.normalizePath(destination));

        if (file.name.endsWith('.xml')) {
          this.mergeReferencedFiles(content, sceneInfo);
        }
      }
      
      assetsStatus.textContent = `Uploaded ${files.length} file(s)`;
      assetsStatus.style.color = '#22c55e';
      this.refreshRequiredFilesUI(sceneInfo);
    }
  
    extractReferencedFiles(xmlDoc) {
      const includes = new Set();
      const assets = new Set();
      
      xmlDoc.querySelectorAll('include').forEach(include => {
        const file = include.getAttribute('file');
        if (file) includes.add(file);
      });
      
      xmlDoc.querySelectorAll('mesh').forEach(mesh => {
        const file = mesh.getAttribute('file');
        if (file) assets.add(file);
      });
      
      xmlDoc.querySelectorAll('texture').forEach(texture => {
        const file = texture.getAttribute('file');
        if (file) assets.add(file);
      });
      
      return {
        includes: Array.from(includes),
        assets: Array.from(assets)
      };
    }
  
    async loadUploadedScene() {
      const sceneName = this.currentUploadPath.split('/')[1];
      const sceneInfo = this.uploadedFiles.get(sceneName);
      
      const sceneSelector = document.getElementById('scene-selector');
      if (sceneSelector) {
        sceneSelector.innerHTML = '';
        const option = document.createElement('option');
        option.value = sceneInfo.xmlPath;
        option.textContent = sceneInfo.robotName || sceneName;
        sceneSelector.appendChild(option);
        sceneSelector.value = sceneInfo.xmlPath;
      }
      
      this.parentContext.params.scene = sceneInfo.xmlPath;
      try {
        await this.parentContext.reloadScene();
        this.parentContext.parentBridge?.emitDirty('assets');
      } catch (error) {
        console.error('Error loading uploaded scene:', error);
        throw error;
      }
    }
  
    createDirectory(path) {
      if (!this.mujoco.FS.analyzePath(path).exists) {
        this.mujoco.FS.mkdir(path);
      }
    }

    ensureParentDirectories(path) {
      const segments = path.split('/').filter(Boolean);
      let currentPath = '';
      for (let i = 0; i < segments.length - 1; i++) {
        currentPath += `/${segments[i]}`;
        this.createDirectory(currentPath);
      }
    }

    normalizePath(path) {
      return path.replace(/^\/working\//, '').replace(/\\/g, '/');
    }

    resolveDestinationPath(fileName, sceneInfo) {
      const references = [...sceneInfo.includes, ...sceneInfo.assets];
      const normalizedFileName = fileName.replace(/\\/g, '/');
      const basename = normalizedFileName.split('/').pop();

      const matchedReference = references.find(reference => {
        const normalizedReference = reference.replace(/\\/g, '/');
        return normalizedReference === normalizedFileName || normalizedReference.split('/').pop() === basename;
      });

      if (!matchedReference) {
        return null;
      }

      return `/working/${this.currentUploadPath}/${matchedReference.replace(/\\/g, '/')}`;
    }

    hasLoadedReference(reference, sceneInfo) {
      const normalizedReference = reference.replace(/\\/g, '/');
      if (sceneInfo.loadedFiles.has(normalizedReference)) {
        return true;
      }

      return [...sceneInfo.loadedFiles].some(loadedFile => {
        return loadedFile === normalizedReference || loadedFile.endsWith(`/${normalizedReference}`);
      });
    }

    mergeReferencedFiles(xmlContent, sceneInfo) {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlContent, 'text/xml');
      const references = this.extractReferencedFiles(xmlDoc);

      references.includes.forEach(reference => sceneInfo.includes.add(reference));
      references.assets.forEach(reference => sceneInfo.assets.add(reference));
    }

    refreshRequiredFilesUI(sceneInfo) {
      const requiredFiles = document.getElementById('required-files');
      const allFiles = [...sceneInfo.includes, ...sceneInfo.assets];
      const missingFiles = allFiles.filter(
        file => !this.hasLoadedReference(file, sceneInfo)
      );

      if (allFiles.length === 0) {
        requiredFiles.style.display = 'none';
        requiredFiles.innerHTML = '';
        document.getElementById('load-robot-btn').disabled = false;
        return;
      }

      requiredFiles.style.display = 'block';
      requiredFiles.innerHTML = '<strong>Required files:</strong><br>' +
        allFiles.map(file => {
          const isLoaded = !missingFiles.includes(file);
          const color = isLoaded ? '#22c55e' : '#f5a524';
          const marker = isLoaded ? '✓' : '•';
          return `<span style="color: ${color};">${marker} ${file}</span>`;
        }).join('<br>');

      document.getElementById('load-robot-btn').disabled = missingFiles.length > 0;
    }

    readFileAsText(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsText(file);
      });
    }
  
    readFileAsArrayBuffer(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
      });
    }
  
    resetUploadState() {
      this.currentUploadPath = null;
      this.uploadedFiles.clear();
      document.getElementById('xml-status').textContent = '';
      document.getElementById('assets-status').textContent = '';
      document.getElementById('required-files').style.display = 'none';
      document.getElementById('required-files').innerHTML = '';
      document.getElementById('select-assets-btn').disabled = true;
      document.getElementById('load-robot-btn').disabled = true;
    }
  }
