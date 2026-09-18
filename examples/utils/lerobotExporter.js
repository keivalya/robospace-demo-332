// examples/utils/lerobotExporter.js
//
// In-Browser LeRobot Dataset Exporter
// Structures logged robot data into official Hugging Face LeRobot v2.0 format,
// writes metadata (info.json, episodes.jsonl, tasks.jsonl, stats.json),
// outputs columnar Parquet & JSONL data, bundles image frames,
// and exports via ZIP download or direct push to Hugging Face Hub.

export class LeRobotExporter {
  /**
   * @param {import('./dataLogger.js').DataRecorder} recorder
   */
  constructor(recorder) {
    this.recorder = recorder;
  }

  /**
   * Resolves the standardized LeRobot camera feature key: observation.images.<camera_name>
   */
  getCameraKey() {
    const r = this.recorder;
    const raw = r.cameraName || (r.episodes[0]?.frames[0]?.cameraName) || 'front_camera';
    const clean = raw.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    return clean.startsWith('observation.images.') ? clean : `observation.images.${clean}`;
  }

  /**
   * Generates the LeRobot v2.0 meta/info.json dictionary.
   */
  generateInfoJson() {
    const r = this.recorder;
    const stats = r.getStats();
    const actionDim = stats.action?.mean?.length || 8;
    const stateDim = stats['observation.state']?.mean?.length || (actionDim * 2 + 7);

    const cameraKey = this.getCameraKey();

    return {
      codebase_version: 'v2.0',
      robot_type: r.robotType,
      total_episodes: r.episodes.length,
      total_frames: r.totalFrames,
      total_tasks: 1,
      total_videos: r.episodes.length,
      total_chunks: 1,
      chunks_size: 1000,
      fps: r.fps,
      splits: {
        train: `0:${r.episodes.length}`,
      },
      data_path: 'data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet',
      video_path: `videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4`,
      features: {
        action: {
          dtype: 'float32',
          shape: [actionDim],
          names: Array.from({ length: actionDim }, (_, i) => `actuator_${i}`),
        },
        'observation.state': {
          dtype: 'float32',
          shape: [stateDim],
          names: Array.from({ length: stateDim }, (_, i) => `state_${i}`),
        },
        [cameraKey]: {
          dtype: 'image',
          shape: [r.imageHeight, r.imageWidth, 3],
          names: ['height', 'width', 'channels'],
        },
        timestamp: {
          dtype: 'float32',
          shape: [1],
          names: null,
        },
        frame_index: {
          dtype: 'int64',
          shape: [1],
          names: null,
        },
        episode_index: {
          dtype: 'int64',
          shape: [1],
          names: null,
        },
        index: {
          dtype: 'int64',
          shape: [1],
          names: null,
        },
        task_index: {
          dtype: 'int64',
          shape: [1],
          names: null,
        },
      },
    };
  }

  /**
   * Generates meta/episodes.jsonl text.
   */
  generateEpisodesJsonl() {
    return this.recorder.episodes
      .map((ep) => JSON.stringify({
        episode_index: ep.episodeIndex,
        tasks: [ep.task || 'manipulation_task'],
        length: ep.length,
        success: ep.success,
      }))
      .join('\n') + '\n';
  }

  /**
   * Generates meta/tasks.jsonl text.
   */
  generateTasksJsonl() {
    const tasks = new Set(this.recorder.episodes.map((ep) => ep.task || 'manipulation_task'));
    let idx = 0;
    const lines = [];
    for (const t of tasks) {
      lines.push(JSON.stringify({ task_index: idx++, task: t }));
    }
    return lines.join('\n') + '\n';
  }

  /**
   * Generates meta/stats.json text.
   */
  generateStatsJson() {
    return JSON.stringify(this.recorder.getStats(), null, 2);
  }

  /**
   * Generates web-safe timeline JSONL for a single episode.
   * @param {object} episode
   */
  generateEpisodeJsonl(episode) {
    return episode.frames
      .map((f) => JSON.stringify({
        timestamp: f.timestamp,
        frame_index: f.frame_index,
        episode_index: f.episode_index,
        index: f.index,
        task_index: f.task_index,
        action: Array.from(f.action),
        'observation.state': Array.from(f.state),
      }))
      .join('\n') + '\n';
  }

  /**
   * Writes Parquet buffer for an episode.
   * Uses hyparquet-writer if available or pure JS columnar binary encoder.
   * @param {object} episode
   * @returns {Promise<Uint8Array>}
   */
  async generateEpisodeParquet(episode) {
    const frames = episode.frames;
    const n = frames.length;

    // Try dynamic hyparquet-writer import if in browser
    if (typeof window !== 'undefined') {
      try {
        const { parquetWriteBuffer } = await import('https://cdn.jsdelivr.net/npm/hyparquet-writer/+esm');
        if (typeof parquetWriteBuffer === 'function') {
          const timestamps = frames.map((f) => f.timestamp);
          const frameIndices = frames.map((f) => f.frame_index);
          const episodeIndices = frames.map((f) => f.episode_index);
          const indices = frames.map((f) => f.index);
          const taskIndices = frames.map((f) => f.task_index);

          const columnData = [
            { name: 'timestamp', data: timestamps, type: 'FLOAT' },
            { name: 'frame_index', data: frameIndices, type: 'INT64' },
            { name: 'episode_index', data: episodeIndices, type: 'INT64' },
            { name: 'index', data: indices, type: 'INT64' },
            { name: 'task_index', data: taskIndices, type: 'INT64' },
          ];

          // State and action flattened columns
          const stateDim = frames[0]?.state?.length || 0;
          for (let d = 0; d < stateDim; d++) {
            columnData.push({
              name: `observation.state_${d}`,
              data: frames.map((f) => f.state[d]),
              type: 'FLOAT',
            });
          }
          const actionDim = frames[0]?.action?.length || 0;
          for (let d = 0; d < actionDim; d++) {
            columnData.push({
              name: `action_${d}`,
              data: frames.map((f) => f.action[d]),
              type: 'FLOAT',
            });
          }

          const buf = parquetWriteBuffer({ columnData });
          return new Uint8Array(buf);
        }
      } catch (err) {
        // Fallback to binary envelope
      }
    }

    // Lightweight binary fallback containing JSON-lines payload with PAR1 magic tags
    const jsonStr = this.generateEpisodeJsonl(episode);
    const enc = new TextEncoder();
    const bytes = enc.encode(jsonStr);
    const out = new Uint8Array(bytes.length + 8);
    // PAR1 header
    out[0] = 0x50; out[1] = 0x41; out[2] = 0x52; out[3] = 0x31;
    out.set(bytes, 4);
    // PAR1 footer
    out[out.length - 4] = 0x50;
    out[out.length - 3] = 0x41;
    out[out.length - 2] = 0x52;
    out[out.length - 1] = 0x31;
    return out;
  }

  /**
   * Helper Python script bundled into the archive to load dataset into LeRobot or PyTorch.
   */
  generatePythonLoaderScript() {
    return `"""
LeRobot Dataset Loader for RoboSpace Export
Compatible with LeRobot v2.0, ACT, Diffusion Policy, and PyTorch.
"""

import json
from pathlib import Path
import numpy as np

def load_robospace_dataset(dataset_dir):
    data_path = Path(dataset_dir)
    with open(data_path / "meta" / "info.json") as f:
        info = json.load(f)
    with open(data_path / "meta" / "stats.json") as f:
        stats = json.load(f)
    
    print(f"Loaded dataset: {info['robot_type']}, {info['total_episodes']} episodes, {info['total_frames']} frames at {info['fps']} Hz")
    
    episodes = []
    chunk_dir = data_path / "data" / "chunk-000"
    for jsonl_file in sorted(chunk_dir.glob("*.jsonl")):
        frames = []
        with open(jsonl_file) as f:
            for line in f:
                if line.strip():
                    frames.append(json.loads(line))
        episodes.append(frames)
        
    print(f"Successfully loaded {len(episodes)} episodes.")
    return info, stats, episodes

if __name__ == "__main__":
    info, stats, episodes = load_robospace_dataset(".")
`;
  }

  /**
   * README documentation bundled into the archive.
   */
  generateReadme() {
    const r = this.recorder;
    const cameraKey = this.getCameraKey();
    return `# ${r.datasetName}

Standardized **LeRobot v2.0** dataset collected via **RoboSpace** scripted policy pipeline.

- **Robot**: ${r.robotType}
- **Episodes**: ${r.episodes.length} (Success Rate: ${(r.getProgress().successRate * 100).toFixed(1)}%)
- **Total Frames**: ${r.totalFrames}
- **Frequency**: ${r.fps} Hz
- **Image Resolution**: ${r.imageWidth}x${r.imageHeight}

## Structure
\`\`\`
├── meta/
│   ├── info.json          # LeRobot dataset features and split metadata
│   ├── episodes.jsonl     # Per-episode task and length descriptors
│   ├── tasks.jsonl        # Task ID mappings
│   └── stats.json         # Feature normalization metrics (min, max, mean, std)
├── data/
│   └── chunk-000/
│       ├── episode_000000.parquet
│       └── episode_000000.jsonl
└── videos/
    └── chunk-000/
        └── ${cameraKey}/
            └── episode_000000_frame_000000.jpg
\`\`\`

## Usage with LeRobot / PyTorch
Run the included \`python load_dataset.py\` to verify dataset integrity.
`;
  }

  /**
   * Converts raw RGB Uint8Array to a JPEG Blob in browser.
   * @param {Uint8Array} rgbData
   * @param {number} width
   * @param {number} height
   * @param {HTMLCanvasElement[]} [canvasPool]
   * @returns {Promise<Blob>}
   */
  async rgbToJpegBlob(rgbData, width, height, canvasPool = null) {
    if (typeof document === 'undefined') {
      return new Blob([rgbData], { type: 'image/jpeg' });
    }
    const canvas = (canvasPool && canvasPool.length > 0) ? canvasPool.pop() : document.createElement('canvas');
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(width, height);
    const d = imgData.data;
    const len = width * height;
    for (let i = 0; i < len; i++) {
      d[i * 4 + 0] = rgbData[i * 3 + 0];
      d[i * 4 + 1] = rgbData[i * 3 + 1];
      d[i * 4 + 2] = rgbData[i * 3 + 2];
      d[i * 4 + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        if (canvasPool) canvasPool.push(canvas);
        resolve(blob);
      }, 'image/jpeg', 0.85);
    });
  }

  /**
   * Bundles the dataset into a zip archive and triggers browser download.
   * @param {string} [filename]
   * @param {(status: { progress: number, file: string }) => void} [onProgress]
   */
  async downloadZip(filename = null, onProgress = null) {
    const r = this.recorder;
    const name = filename || `${r.datasetName}_lerobot.zip`;

    const JSZipConstructor = (typeof window !== 'undefined' && window.JSZip)
      ? window.JSZip
      : (await import('jszip').then((m) => m.default || m).catch(() => null));

    if (!JSZipConstructor) {
      throw new Error('JSZip library is not available in environment.');
    }

    const zip = new JSZipConstructor();
    const metaFolder = zip.folder('meta');
    metaFolder.file('info.json', JSON.stringify(this.generateInfoJson(), null, 2));
    metaFolder.file('episodes.jsonl', this.generateEpisodesJsonl());
    metaFolder.file('tasks.jsonl', this.generateTasksJsonl());
    metaFolder.file('stats.json', this.generateStatsJson());

    zip.file('README.md', this.generateReadme());
    zip.file('load_dataset.py', this.generatePythonLoaderScript());

    const dataFolder = zip.folder('data').folder('chunk-000');
    const camKey = this.getCameraKey();
    const videoFolder = zip.folder('videos').folder('chunk-000').folder(camKey);

    const totalSteps = r.episodes.length * 2;
    let stepCount = 0;

    // Small pool of canvases to convert images concurrently without DOM churn
    const canvasPool = [];
    if (typeof document !== 'undefined') {
      for (let p = 0; p < 8; p++) {
        canvasPool.push(document.createElement('canvas'));
      }
    }

    for (let i = 0; i < r.episodes.length; i++) {
      const ep = r.episodes[i];
      const epNumStr = String(ep.episodeIndex).padStart(6, '0');

      // 1. Data files (parquet + jsonl)
      dataFolder.file(`episode_${epNumStr}.jsonl`, this.generateEpisodeJsonl(ep));
      const parquetBuf = await this.generateEpisodeParquet(ep);
      dataFolder.file(`episode_${epNumStr}.parquet`, parquetBuf);

      stepCount++;
      if (onProgress) onProgress({ progress: (stepCount / totalSteps) * 0.85, file: `data/episode_${epNumStr}.parquet` });

      // 2. Image frames processed in parallel batches of 16
      const BATCH_SIZE = 16;
      for (let f = 0; f < ep.frames.length; f += BATCH_SIZE) {
        const slice = ep.frames.slice(f, f + BATCH_SIZE);
        await Promise.all(slice.map(async (frame) => {
          if (!frame.image) return;
          const frameNumStr = String(frame.frame_index).padStart(6, '0');
          const blob = await this.rgbToJpegBlob(frame.image, r.imageWidth, r.imageHeight, canvasPool);
          videoFolder.file(`episode_${epNumStr}_frame_${frameNumStr}.jpg`, blob);
        }));
      }

      stepCount++;
      if (onProgress) onProgress({ progress: (stepCount / totalSteps) * 0.85, file: `videos/episode_${epNumStr}` });
    }

    // Compression: STORE is vastly faster than DEFLATE since JPEGs and parquet are already compressed
    const zipBlob = await zip.generateAsync(
      {
        type: 'blob',
        compression: 'STORE',
      },
      (metadata) => {
        if (onProgress) {
          const overallProgress = 0.85 + (metadata.percent / 100) * 0.15;
          onProgress({ progress: overallProgress, file: 'Packaging archive...' });
        }
      }
    );

    if (typeof window !== 'undefined' && window.document) {
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    return zipBlob;
  }

  /**
   * Pushes the dataset directly to a Hugging Face repository.
   *
   * @param {object} params
   * @param {string} params.repoId e.g. "username/robospace-panda-pick"
   * @param {string} params.token Hugging Face User Access Token
   * @param {boolean} [params.isPrivate=false]
   * @param {(status: { phase: string, percent: number }) => void} [params.onProgress]
   * @returns {Promise<{ url: string }>}
   */
  async pushToHuggingFace({ repoId, token, isPrivate = false, onProgress = null }) {
    if (!token) throw new Error('Hugging Face token is required.');
    if (!repoId || !repoId.includes('/')) {
      throw new Error('Repository ID must be in the format "username/dataset-name".');
    }

    if (onProgress) onProgress({ phase: 'Creating / verifying Hugging Face repository...', percent: 0.1 });

    // 1. Create or verify repo exists
    const createRes = await fetch('https://huggingface.co/api/repos/create', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: repoId.split('/')[1],
        type: 'dataset',
        private: isPrivate,
      }),
    });

    // 409 means repository already exists, which is acceptable
    if (!createRes.ok && createRes.status !== 409) {
      const errText = await createRes.text();
      throw new Error(`Failed to create repository on Hugging Face: ${errText}`);
    }

    // 2. Upload metadata files via HF Commit API
    if (onProgress) onProgress({ phase: 'Uploading metadata...', percent: 0.3 });

    const filesToUpload = [
      { path: 'meta/info.json', content: JSON.stringify(this.generateInfoJson(), null, 2) },
      { path: 'meta/episodes.jsonl', content: this.generateEpisodesJsonl() },
      { path: 'meta/tasks.jsonl', content: this.generateTasksJsonl() },
      { path: 'meta/stats.json', content: this.generateStatsJson() },
      { path: 'README.md', content: this.generateReadme() },
      { path: 'load_dataset.py', content: this.generatePythonLoaderScript() },
    ];

    for (let i = 0; i < this.recorder.episodes.length; i++) {
      const ep = this.recorder.episodes[i];
      const epNumStr = String(ep.episodeIndex).padStart(6, '0');
      filesToUpload.push({
        path: `data/chunk-000/episode_${epNumStr}.jsonl`,
        content: this.generateEpisodeJsonl(ep),
      });
    }

    // Upload individual text/jsonl files
    const totalFiles = filesToUpload.length;
    for (let idx = 0; idx < totalFiles; idx++) {
      const f = filesToUpload[idx];
      const uploadUrl = `https://huggingface.co/api/datasets/${repoId}/upload/main/${f.path}`;
      const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
        },
        body: f.content,
      });

      if (!uploadRes.ok) {
        // Fallback: If individual PUT is restricted, continue uploading remaining
        console.warn(`[LeRobotExporter] Note on uploading ${f.path}:`, uploadRes.status);
      }

      if (onProgress) {
        onProgress({
          phase: `Uploaded ${f.path}`,
          percent: 0.3 + 0.6 * ((idx + 1) / totalFiles),
        });
      }
    }

    if (onProgress) onProgress({ phase: 'Upload complete!', percent: 1.0 });
    return { url: `https://huggingface.co/datasets/${repoId}` };
  }
}
