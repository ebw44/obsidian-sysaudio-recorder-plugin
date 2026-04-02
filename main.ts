import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";
import * as path from "path";
// @ts-ignore
import fixWebmDuration from "fix-webm-duration";

interface AudioRecorderSettings {
  recordingsFolder: string;
  recordMicrophone: boolean;
  selectedMicrophoneId: string;
  muteHotkey: string; // Global hotkey for mute toggle
  outputFormat: "webm" | "wav";
  controlWindowWidth: number;
  controlWindowHeight: number;
}

const DEFAULT_SETTINGS: AudioRecorderSettings = {
  recordingsFolder: "Recordings",
  recordMicrophone: true,
  selectedMicrophoneId: "default",
  muteHotkey: "CommandOrControl+Shift+M", // Default global hotkey
  outputFormat: "webm",
  controlWindowWidth: 320,
  controlWindowHeight: 55
};

export default class AudioRecorderPlugin extends Plugin {
  settings: AudioRecorderSettings;
  recorder: MediaRecorder | null = null;
  chunks: Blob[] = [];
  recordingStream: MediaStream | null = null;
  micStream: MediaStream | null = null;
  audioContext: AudioContext | null = null;
  micGainNode: GainNode | null = null;
  isMicMuted: boolean = false;
  analyserNode: AnalyserNode | null = null;
  statusBarItem: HTMLElement | null = null;
  activeFileAtStart: TFile | null = null;
  controlWindow: any = null; // BrowserWindow
  processorNode: ScriptProcessorNode | null = null;
  muteGainNode: GainNode | null = null;
  animationIntervalId: NodeJS.Timeout | null = null;
  electron: any = null; // Electron reference
  startTime: number = 0;

  // Audio properties
  sampleRate: number = 44100;
  numChannels: number = 2;

  async onload() {
    await this.loadSettings();

    // Ribbon Icon
    const ribbonIconEl = this.addRibbonIcon(
      "microphone",
      "Start/Stop Recording",
      (evt: MouseEvent) => {
        this.toggleRecording();
      },
    );
    ribbonIconEl.addClass("audio-recorder-ribbon-class");

    // Status Bar
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.setText("");

    // Command
    this.addCommand({
      id: "start-stop-recording",
      name: "Start/Stop Recording",
      callback: () => {
        this.toggleRecording();
      },
    });

    // Mute Toggle Command with Hotkey
    this.addCommand({
      id: "toggle-mic-mute",
      name: "Toggle Microphone Mute",
      callback: () => {
        this.toggleMute();
      },
    });

    // Settings
    this.addSettingTab(new AudioRecorderSettingTab(this.app, this));
  }

  onunload() {
    this.stopRecording();
    this.unregisterGlobalHotkey();
  }

  async toggleRecording() {
    if (this.recorder && this.recorder.state === "recording") {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  toggleMute() {
    // Only allow muting during active recording
    const isRecording = this.recorder && this.recorder.state === "recording";

    if (!isRecording) {
      new Notice("No active recording to mute/unmute microphone.");
      return;
    }

    if (!this.micGainNode) {
      new Notice("Microphone is not being recorded.");
      return;
    }

    this.isMicMuted = !this.isMicMuted;
    this.micGainNode.gain.value = this.isMicMuted ? 0 : 1;

    // Update the control window if it exists
    if (this.controlWindow && !this.controlWindow.isDestroyed()) {
      this.controlWindow.webContents.send("toggle-mute-state", this.isMicMuted);
    }

    new Notice(this.isMicMuted ? "Microphone muted" : "Microphone unmuted");
  }


  async startRecording() {
    try {
      this.activeFileAtStart = this.app.workspace.getActiveFile();

      // Use Electron's desktopCapturer to get sources
      // @ts-ignore
      const electron = require("electron");
      this.electron = electron; // Store for later use
      let desktopCapturer = electron.desktopCapturer;
      let remote = electron.remote;

      // Fallback for some Electron versions/configs
      if (!desktopCapturer && remote) {
        desktopCapturer = remote.desktopCapturer;
      }

      if (!desktopCapturer) {
        new Notice("Error: desktopCapturer API is not available.");
        return;
      }

      // Register global hotkey for mute toggle
      this.registerGlobalHotkey();

      // Auto-select the first screen (Primary Display)
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      if (sources.length === 0) {
        new Notice("No screen sources found.");
        return;
      }
      const source = sources[0]; // Primary screen

      // 1. Get System Audio Stream
      const systemStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: source.id,
          },
        },
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: source.id,
          },
        },
      } as any);

      // Check system audio tracks
      const systemAudioTracks = systemStream.getAudioTracks();
      if (systemAudioTracks.length === 0) {
        new Notice(
          "No system audio track captured. Ensure you are on Windows or have system audio setup.",
        );
      }

      this.recordingStream = systemStream;

      // 2. Get Microphone Stream (if enabled)
      if (this.settings.recordMicrophone) {
        try {
          const constraints: any = { audio: true };
          if (
            this.settings.selectedMicrophoneId &&
            this.settings.selectedMicrophoneId !== "default"
          ) {
            constraints.audio = {
              deviceId: { exact: this.settings.selectedMicrophoneId },
            };
          }

          this.micStream =
            await navigator.mediaDevices.getUserMedia(constraints);
        } catch (micErr) {
          console.error("Error capturing microphone:", micErr);
          new Notice(
            "Failed to capture microphone. Recording system audio only.",
          );
        }
      }

      // 3. Mix Streams & Setup Audio Context
      let finalStream: MediaStream;
      this.audioContext = new AudioContext();
      this.sampleRate = this.audioContext.sampleRate; // Capture actual sample rate
      const destination = this.audioContext.createMediaStreamDestination();

      // Create a Master Gain Node to mix everything before sending to destination/analyser
      const masterGain = this.audioContext.createGain();
      masterGain.connect(destination);

      // Setup Analyser
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 128;
      this.analyserNode.smoothingTimeConstant = 0.5;
      masterGain.connect(this.analyserNode);

      // System Audio Node
      if (systemAudioTracks.length > 0) {
        const systemSource =
          this.audioContext.createMediaStreamSource(systemStream);
        systemSource.connect(masterGain);
      }

      // Mic Audio Node
      if (this.micStream) {
        const micSource = this.audioContext.createMediaStreamSource(
          this.micStream,
        );
        this.micGainNode = this.audioContext.createGain();
        this.micGainNode.gain.value = 1.0;
        micSource.connect(this.micGainNode);
        this.micGainNode.connect(masterGain);
      }

      finalStream = destination.stream;

      if (finalStream.getAudioTracks().length === 0) {
        new Notice("No audio tracks available to record.");
        this.stopRecordingStreams();
        return;
      }

      // Always use MediaRecorder (WebM) for recording
      // If WAV is selected, we'll convert it after recording stops
      this.recorder = new MediaRecorder(finalStream, {
        mimeType: "audio/webm",
      });
      this.chunks = [];

      this.recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          this.chunks.push(e.data);
        }
      };

      this.recorder.onstop = async () => {
        const webmBlob = new Blob(this.chunks, { type: "audio/webm" });

        let finalBlob: Blob;
        if (this.settings.outputFormat === "wav") {
          // Convert WebM to WAV
          new Notice("Converting to WAV...");
          finalBlob = await this.convertWebMToWAV(webmBlob);
        } else {
          // Keep as WebM
          finalBlob = webmBlob;
        }

        await this.saveRecording(finalBlob);
        this.stopRecordingStreams();
        this.statusBarItem?.setText("");
        new Notice("Recording saved.");
        this.closeControlWindow();
      };

      this.recorder.start();

      this.startTime = Date.now();
      this.statusBarItem?.setText("Recording...");
      new Notice("Recording started.");

      // Open Control Window
      this.openControlWindow(electron);
      this.startAudioVisualization();
    } catch (err) {
      console.error("Error starting recording:", err);
      new Notice("Failed to start recording. See console for details.");
      this.stopRecordingStreams();
    }
  }

  openControlWindow(electron: any) {
    const remote = electron.remote || electron;
    const BrowserWindow = remote.BrowserWindow;
    const ipcMain = remote.ipcMain;

    // Calculate position (bottom center)
    const { width, height } = remote.screen.getPrimaryDisplay().workAreaSize;
    const controlWidth = Number.isFinite(this.settings.controlWindowWidth) ? this.settings.controlWindowWidth : 320;
    const controlHeight = Number.isFinite(this.settings.controlWindowHeight) ? this.settings.controlWindowHeight : 110;

    this.controlWindow = new BrowserWindow({
      width: controlWidth,
      height: controlHeight,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000", // Force transparency
      hasShadow: false, // Disable native shadow to prevent black corners
      alwaysOnTop: true,
      resizable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        backgroundThrottling: false, // Prevent throttling when in background
      },
      x: Math.floor(width / 2 - controlWidth / 2),
      y: height - controlHeight,
    });

    // Load HTML
    // @ts-ignore
    const pluginDir = this.app.vault.adapter.basePath + "/" + this.manifest.dir;
    const htmlPath = path.join(pluginDir, "control-window.html");
    this.controlWindow.loadFile(htmlPath);

    this.controlWindow.webContents.on("did-finish-load", () => {
      // Get Obsidian's accent color from CSS variables
      const accentColor =
        getComputedStyle(document.body).getPropertyValue(
          "--interactive-accent",
        ) || "#7c3aed"; // Fallback to purple
      this.controlWindow.webContents.send("set-accent-color", accentColor);
    });

    // IPC Handlers
    const onMuteMic = () => {
      if (this.micGainNode) {
        this.micGainNode.gain.value = 0;
        this.isMicMuted = true;
      }
    };
    const onUnmuteMic = () => {
      if (this.micGainNode) {
        this.micGainNode.gain.value = 1;
        this.isMicMuted = false;
      }
    };
    const onStopRecording = () => {
      this.stopRecording();
    };

    ipcMain.on("mute-mic", onMuteMic);
    ipcMain.on("unmute-mic", onUnmuteMic);
    ipcMain.on("stop-recording", onStopRecording);

    // Cleanup on window close
    this.controlWindow.on("closed", () => {
      ipcMain.removeListener("mute-mic", onMuteMic);
      ipcMain.removeListener("unmute-mic", onUnmuteMic);
      ipcMain.removeListener("stop-recording", onStopRecording);
      this.controlWindow = null;
    });
  }

  closeControlWindow() {
    if (this.controlWindow) {
      this.controlWindow.close();
      this.controlWindow = null;
    }

    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode = null;
    }

    if (this.muteGainNode) {
      this.muteGainNode.disconnect();
      this.muteGainNode = null;
    }
  }

  startAudioVisualization() {
    if (!this.analyserNode || !this.controlWindow || !this.audioContext) return;

    const dataArray = new Uint8Array(this.analyserNode.frequencyBinCount);

    this.processorNode = this.audioContext.createScriptProcessor(2048, 1, 1);

    this.muteGainNode = this.audioContext.createGain();
    this.muteGainNode.gain.value = 0;

    this.analyserNode.connect(this.processorNode);
    this.processorNode.connect(this.muteGainNode);
    this.muteGainNode.connect(this.audioContext.destination);

    this.processorNode.onaudioprocess = () => {
      if (!this.analyserNode || !this.controlWindow) {
        if (this.processorNode) {
          this.processorNode.disconnect();
          this.processorNode = null;
        }
        return;
      }

      this.analyserNode.getByteFrequencyData(dataArray);

      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const average = sum / dataArray.length / 255;

      try {
        if (!this.controlWindow.isDestroyed()) {
          this.controlWindow.webContents.send("audio-level", average);
        }
      } catch (err) {
        // Window might be closed
      }
    };
  }

  async stopRecording() {
    if (this.recorder && this.recorder.state === "recording") {
      this.recorder.stop();
    }
    this.unregisterGlobalHotkey();
  }

  async convertWebMToWAV(webmBlob: Blob): Promise<Blob> {
    // Decode WebM to raw audio data
    const arrayBuffer = await webmBlob.arrayBuffer();
    const audioBuffer = await this.audioContext!.decodeAudioData(arrayBuffer);

    // Update sample rate from decoded audio
    this.sampleRate = audioBuffer.sampleRate;
    this.numChannels = audioBuffer.numberOfChannels;

    // Extract channel data
    const channels: Float32Array[] = [];
    for (let i = 0; i < this.numChannels; i++) {
      channels.push(audioBuffer.getChannelData(i));
    }

    // Interleave channels
    let interleaved: Float32Array;
    if (this.numChannels === 2) {
      interleaved = this.interleave(channels[0], channels[1]);
    } else if (this.numChannels === 1) {
      // Mono - duplicate to stereo for consistency
      interleaved = this.interleave(channels[0], channels[0]);
      this.numChannels = 2;
    } else {
      // More than 2 channels - mix down to stereo
      const left = new Float32Array(audioBuffer.length);
      const right = new Float32Array(audioBuffer.length);
      for (let i = 0; i < audioBuffer.length; i++) {
        left[i] = channels[0][i];
        right[i] = channels[Math.min(1, channels.length - 1)][i];
      }
      interleaved = this.interleave(left, right);
      this.numChannels = 2;
    }

    // Create WAV file
    const wavData = this.writeWavHeader(interleaved);
    return new Blob([wavData], { type: "audio/wav" });
  }

  stopRecordingStreams() {
    if (this.recordingStream) {
      this.recordingStream.getTracks().forEach((track) => track.stop());
      this.recordingStream = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }

    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode = null;
    }

    if (this.muteGainNode) {
      this.muteGainNode.disconnect();
      this.muteGainNode = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.recorder = null;
  }

  registerGlobalHotkey() {
    if (!this.electron || !this.settings.muteHotkey) return;

    try {
      const remote = this.electron.remote || this.electron;
      const { globalShortcut } = remote;

      this.unregisterGlobalHotkey();

      const registered = globalShortcut.register(
        this.settings.muteHotkey,
        () => {
          this.toggleMute();
        }
      );

      if (!registered) {
        console.warn(
          `Failed to register global hotkey: ${this.settings.muteHotkey}`
        );
      }
    } catch (err) {
      console.error("Error registering global hotkey:", err);
    }
  }

  unregisterGlobalHotkey() {
    if (!this.electron || !this.settings.muteHotkey) return;

    try {
      const remote = this.electron.remote || this.electron;
      const { globalShortcut } = remote;

      if (globalShortcut.isRegistered(this.settings.muteHotkey)) {
        globalShortcut.unregister(this.settings.muteHotkey);
      }
    } catch (err) {
      console.error("Error unregistering global hotkey:", err);
    }
  }

  async saveRecording(blob: Blob) {
    let buffer: Uint8Array;

    if (this.settings.outputFormat === "webm") {
      const duration = Date.now() - this.startTime;
      const fixedBlob = await new Promise<Blob>((resolve) => {
        fixWebmDuration(blob, duration, (fixed: Blob) => {
          resolve(fixed);
        });
      });
      const arrayBuffer = await fixedBlob.arrayBuffer();
      buffer = new Uint8Array(arrayBuffer);
    } else {
      const arrayBuffer = await blob.arrayBuffer();
      buffer = new Uint8Array(arrayBuffer);
    }

    const folderPath = this.settings.recordingsFolder;
    if (!(await this.app.vault.adapter.exists(folderPath))) {
      await this.app.vault.createFolder(folderPath);
    }

    const now = new Date();
    const timestamp = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")} ${now.getHours().toString().padStart(2, "0")}.${now.getMinutes().toString().padStart(2, "0")}.${now.getSeconds().toString().padStart(2, "0")}`;
    const extension = this.settings.outputFormat;
    const filename = `${folderPath}/Recording ${timestamp}.${extension}`;

    // @ts-ignore
    const file = await this.app.vault.createBinary(filename, buffer.buffer);

    if (this.activeFileAtStart) {
      const linkText = `\n![[${file.path}]]\n`;
      await this.app.vault.append(this.activeFileAtStart, linkText);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  interleave(leftChannel: Float32Array, rightChannel: Float32Array) {
    const length = leftChannel.length + rightChannel.length;
    const result = new Float32Array(length);

    let inputIndex = 0;

    for (let index = 0; index < length;) {
      result[index++] = leftChannel[inputIndex];
      result[index++] = rightChannel[inputIndex];
      inputIndex++;
    }
    return result;
  }

  convertFloat32ToInt16(buffer: Float32Array) {
    let l = buffer.length;
    const buf = new Int16Array(l);
    while (l--) {
      buf[l] = Math.min(1, Math.max(-1, buffer[l])) * 0x7fff;
    }
    return buf;
  }

  writeWavHeader(samples: Float32Array) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    this.writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    this.writeString(view, 8, "WAVE");
    this.writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, this.numChannels, true);
    view.setUint32(24, this.sampleRate, true);
    view.setUint32(28, this.sampleRate * 4, true);
    view.setUint16(32, this.numChannels * 2, true);
    view.setUint16(34, 16, true);
    this.writeString(view, 36, "data");
    view.setUint32(40, samples.length * 2, true);

    this.floatTo16BitPCM(view, 44, samples);

    return view;
  }

  floatTo16BitPCM(output: DataView, offset: number, input: Float32Array) {
    for (let i = 0; i < input.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, input[i]));
      output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }

  writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }
}

class AudioRecorderSettingTab extends PluginSettingTab {
  plugin: AudioRecorderPlugin;

  constructor(app: App, plugin: AudioRecorderPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl("h2", { text: "Settings for Audio Recorder" });

    new Setting(containerEl)
      .setName("Recordings Folder")
      .setDesc("Folder to save audio recordings in")
      .addText((text) =>
        text
          .setPlaceholder("Recordings")
          .setValue(this.plugin.settings.recordingsFolder)
          .onChange(async (value) => {
            this.plugin.settings.recordingsFolder = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Record Microphone")
      .setDesc("Record microphone audio along with system audio.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.recordMicrophone)
          .onChange(async (value) => {
            this.plugin.settings.recordMicrophone = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Microphone Source")
      .setDesc("Select the microphone to record.")
      .addDropdown(async (dropdown) => {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter((d) => d.kind === "audioinput");

        audioInputs.forEach((device) => {
          dropdown.addOption(
            device.deviceId,
            device.label || `Microphone ${device.deviceId}`,
          );
        });

        dropdown.setValue(this.plugin.settings.selectedMicrophoneId);
        dropdown.onChange(async (value) => {
          this.plugin.settings.selectedMicrophoneId = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Output Format")
      .setDesc("Select the audio output format.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("webm", "WebM")
          .addOption("wav", "WAV")
          .setValue(this.plugin.settings.outputFormat)
          .onChange(async (value: "webm" | "wav") => {
            this.plugin.settings.outputFormat = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Control Window Width")
      .setDesc("Width of the recording control overlay window in pixels.")
      .addText((text) =>
        text
          .setPlaceholder("320")
          .setValue(String(this.plugin.settings.controlWindowWidth))
          .onChange(async (value) => {
            const width = parseInt(value, 10);
            if (!Number.isNaN(width) && width > 0) {
              this.plugin.settings.controlWindowWidth = width;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Control Window Height")
      .setDesc("Height of the recording control overlay window in pixels.")
      .addText((text) =>
        text
          .setPlaceholder("110")
          .setValue(String(this.plugin.settings.controlWindowHeight))
          .onChange(async (value) => {
            const height = parseInt(value, 10);
            if (!Number.isNaN(height) && height > 0) {
            this.plugin.settings.controlWindowHeight = height;
              await this.plugin.saveSettings();
            }
          })
      );

    // Hotkeys Section
    containerEl.createEl("h3", { text: "Hotkeys" });

    new Setting(containerEl)
      .setName("Global Mute Hotkey")
      .setDesc(
        "Set a system-wide hotkey to toggle microphone muting (works even when Obsidian isn't focused). " +
        "Uses Electron's accelerator format. Examples: 'CommandOrControl+Shift+M', 'Alt+M', 'Ctrl+Shift+Space'. " +
        "Changes take effect when starting a new recording."
      )
      .addText((text) =>
        text
          .setPlaceholder("CommandOrControl+Shift+M")
          .setValue(this.plugin.settings.muteHotkey)
          .onChange(async (value) => {
            this.plugin.settings.muteHotkey = value;
            await this.plugin.saveSettings();
          })
      );

    const hotkeyDesc = containerEl.createDiv();
    hotkeyDesc.addClass("setting-item-description");
    hotkeyDesc.setText(
      "You can also use Obsidian's built-in hotkeys (Settings → Hotkeys → 'Toggle Microphone Mute'), " +
      "but those only work when Obsidian is focused."
    );
    hotkeyDesc.style.marginBottom = "1em";
  }
}
