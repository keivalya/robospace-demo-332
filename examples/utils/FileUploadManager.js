// examples/utils/FileUploadManager.js
export class FileUploadManager {
    constructor(mujoco, parentContext) {
      this.mujoco = mujoco;
      this.parentContext = parentContext;
      this.uploadedFiles = new Map();
      this.currentUploadPath = null;
    }
  
    createUploadInterface() {
      // Guard against being called more than once
      if (document.getElementById('upload-robot-button')) return;

      const toolbar = document.getElementById('toolbar');
      
      // Create a new toolbar section for upload
      const uploadSection = document.createElement('div');
      uploadSection.className = 'toolbar-section';
      uploadSection.innerHTML = `
        <button id="upload-robot-button" class="toolbar-button">📁 Upload Robot</button>
        <span id="upload-status" class="toolbar-value" style="display: none;"></span>
      `;
      
      // Insert after the first toolbar section inside the collapsible wrapper
      const collapsible = document.getElementById('toolbar-collapsible') || toolbar;
      const sceneSection = collapsible.querySelector('.toolbar-section');
      collapsible.insertBefore(uploadSection, sceneSection.nextSibling);
      
      // Create hidden file inputs
      const xmlInput = document.createElement('input');
      xmlInput.type = 'file';
      xmlInput.accept = '.xml';
      xmlInput.style.display = 'none';
      document.body.appendChild(xmlInput);
      
      const assetsInput = document.createElement('input');
      assetsInput.type = 'file';
      assetsInput.accept = '.xml,.stl,.obj,.png,.jpg,.jpeg';
      assetsInput.multiple = true;
      assetsInput.style.display = 'none';
      document.body.appendChild(assetsInput);
      
      // Create upload dialog
      const uploadDialog = document.createElement('div');
      uploadDialog.id = 'upload-dialog';
      uploadDialog.style.cssText = `
        display: none;
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: #2a2a2a;
        border: 2px solid #0a7fff;
        border-radius: 8px;
        padding: 20px;
        z-index: 2000;
        color: #fff;
        min-width: 400px;
      `;
      uploadDialog.innerHTML = `
        <h3 style="margin-top: 0; color: #0a7fff;">Upload Robot Files</h3>
        <div id="upload-instructions" style="margin: 15px 0; line-height: 1.5;">
          <p><strong>Step 1:</strong> Upload your scene XML file</p>
          <button id="select-xml-btn" class="toolbar-button" style="margin: 10px 0;">Select Scene XML</button>
          <div id="xml-status" style="color: #888; margin: 5px 0;"></div>
          
          <p style="margin-top: 15px;"><strong>Step 2:</strong> Upload referenced files (if any)</p>
          <div id="required-files" style="color: #ff9800; margin: 10px 0; display: none;"></div>
          <button id="select-assets-btn" class="toolbar-button" style="margin: 10px 0;" disabled>Select Asset Files</button>
          <div id="assets-status" style="color: #888; margin: 5px 0;"></div>
        </div>
        <div style="text-align: right; margin-top: 20px;">
          <button id="load-robot-btn" class="toolbar-button" style="background: #0a7fff;" disabled>Load Robot</button>
          <button id="cancel-upload-btn" class="toolbar-button" style="margin-left: 10px;">Cancel</button>
        </div>
      `;
      document.body.appendChild(uploadDialog);
      
      // Upload button click handler
      document.getElementById('upload-robot-button').addEventListener('click', () => {
        uploadDialog.style.display = 'block';
        this.resetUploadState();
      });
      
      // Select XML button
      document.getElementById('select-xml-btn').addEventListener('click', () => {
        xmlInput.click();
      });
      
      // Select assets button
      document.getElementById('select-assets-btn').addEventListener('click', () => {
        assetsInput.click();
      });
      
      // Cancel button
      document.getElementById('cancel-upload-btn').addEventListener('click', () => {
        uploadDialog.style.display = 'none';
        this.resetUploadState();
      });
      
      // Load robot button
      document.getElementById('load-robot-btn').addEventListener('click', async () => {
        await this.loadUploadedScene();
        uploadDialog.style.display = 'none';
      });
      
      // Handle XML upload
      xmlInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) {
          await this.handleXMLUpload(file);
        }
      });
      
      // Handle assets upload
      assetsInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        if (files.length > 0) {
          await this.handleAssetsUpload(files);
        }
      });
    }
  
    async handleXMLUpload(file) {
      try {
        const xmlStatus = document.getElementById('xml-status');
        xmlStatus.textContent = `Selected: ${file.name}`;
        xmlStatus.style.color = '#4CAF50';
        
        const content = await this.readFileAsText(file);
        
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
        
        // Store info
        this.uploadedFiles.set(sceneName, {
          xmlPath: `${this.currentUploadPath}/scene.xml`,
          includes: new Set(references.includes),
          assets: new Set(references.assets),
          loadedFiles: new Set()
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
  
    async handleAssetsUpload(files) {
      const sceneName = this.currentUploadPath.split('/')[1];
      const sceneInfo = this.uploadedFiles.get(sceneName);
      const assetsStatus = document.getElementById('assets-status');
      
      for (const file of files) {
        const destination = this.resolveDestinationPath(file.name, sceneInfo);
        if (!destination) {
          continue;
        }

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
      assetsStatus.style.color = '#4CAF50';
      this.refreshRequiredFilesUI(sceneInfo);
    }
  
    extractReferencedFiles(xmlDoc) {
      const includes = new Set();
      const assets = new Set();
      
      // Check for included XML files
      xmlDoc.querySelectorAll('include').forEach(include => {
        const file = include.getAttribute('file');
        if (file) includes.add(file);
      });
      
      // Check for mesh files
      xmlDoc.querySelectorAll('mesh').forEach(mesh => {
        const file = mesh.getAttribute('file');
        if (file) assets.add(file);
      });
      
      // Check for texture files
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
      
      // Add to scene selector
      const sceneSelector = document.getElementById('scene-selector');
      const existingOption = [...sceneSelector.options].find(
        option => option.value === sceneInfo.xmlPath
      );
      if (!existingOption) {
        const option = document.createElement('option');
        option.value = sceneInfo.xmlPath;
        option.textContent = `Custom: ${sceneName}`;
        sceneSelector.appendChild(option);
      }
      sceneSelector.value = sceneInfo.xmlPath;
      
      // Update params and reload
      this.parentContext.params.scene = sceneInfo.xmlPath;
      try {
        await this.parentContext.reloadScene();
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
          const color = isLoaded ? '#4CAF50' : '#ff9800';
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
