import type { ExportConfig, ExportProgress, ExportResult } from './types';
import { VideoFileDecoder } from './videoDecoder';
import { FrameRenderer } from './frameRenderer';
import { VideoMuxer } from './muxer';
import type { ZoomRegion, CropRegion, TrimRegion, AnnotationRegion } from '@/components/video-editor/types';

interface VideoExporterConfig extends ExportConfig {
  videoUrl: string;
  wallpaper: string;
  zoomRegions: ZoomRegion[];
  trimRegions?: TrimRegion[];
  showShadow: boolean;
  shadowIntensity: number;
  showBlur: boolean;
  motionBlurEnabled?: boolean;
  borderRadius?: number;
  padding?: number;
  videoPadding?: number;
  cropRegion: CropRegion;
  annotationRegions?: AnnotationRegion[];
  previewWidth?: number;
  previewHeight?: number;
  onProgress?: (progress: ExportProgress) => void;
}

export class VideoExporter {
  private config: VideoExporterConfig;
  private decoder: VideoFileDecoder | null = null;
  private renderer: FrameRenderer | null = null;
  private encoder: VideoEncoder | null = null;
  private audioEncoder: AudioEncoder | null = null;
  private muxer: VideoMuxer | null = null;
  private cancelled = false;
  private encodeQueue = 0;
  // Increased queue size for better throughput with hardware encoding
  private readonly MAX_ENCODE_QUEUE = 120;
  private videoDescription: Uint8Array | undefined;
  private videoColorSpace: VideoColorSpaceInit | undefined;
  // Track muxing promises for parallel processing
  private muxingPromises: Promise<void>[] = [];
  private chunkCount = 0;
  private audioChunkCount = 0;
  // Promise-based encoder queue signaling
  private encodeQueueResolvers: Array<() => void> = [];
  // Audio buffer for the source video
  private audioBuffer: AudioBuffer | null = null;
  private hasAudio = false;

  constructor(config: VideoExporterConfig) {
    this.config = config;
  }

  // Build playback segments excluding trim regions
  private buildPlaybackSegments(totalDuration: number): Array<{ startMs: number; endMs: number }> {
    const trimRegions = this.config.trimRegions || [];
    const sortedTrims = [...trimRegions].sort((a, b) => a.startMs - b.startMs);
    
    const segments: Array<{ startMs: number; endMs: number }> = [];
    let currentStart = 0;
    
    for (const trim of sortedTrims) {
      if (trim.startMs > currentStart) {
        segments.push({ startMs: currentStart, endMs: trim.startMs });
      }
      currentStart = trim.endMs;
    }
    
    // Add final segment after last trim
    const totalMs = totalDuration * 1000;
    if (currentStart < totalMs) {
      segments.push({ startMs: currentStart, endMs: totalMs });
    }
    
    return segments;
  }

  // Signal that encoder queue has space
  private signalEncoderQueueSpace(): void {
    while (this.encodeQueueResolvers.length > 0 && this.encodeQueue < this.MAX_ENCODE_QUEUE) {
      const resolver = this.encodeQueueResolvers.shift();
      resolver?.();
    }
  }

  // Wait for encoder queue to have space
  private waitForEncoderQueue(): Promise<void> {
    if (this.encodeQueue < this.MAX_ENCODE_QUEUE) {
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.encodeQueueResolvers.push(resolve);
    });
  }

  // Calculate the total duration excluding trim regions (in seconds)
  private getEffectiveDuration(totalDuration: number): number {
    const trimRegions = this.config.trimRegions || [];
    const totalTrimDuration = trimRegions.reduce((sum, region) => {
      return sum + (region.endMs - region.startMs) / 1000;
    }, 0);
    return totalDuration - totalTrimDuration;
  }

  private mapEffectiveToSourceTime(effectiveTimeMs: number): number {
    const trimRegions = this.config.trimRegions || [];
    // Sort trim regions by start time
    const sortedTrims = [...trimRegions].sort((a, b) => a.startMs - b.startMs);

    let sourceTimeMs = effectiveTimeMs;

    for (const trim of sortedTrims) {
      // If the source time hasn't reached this trim region yet, we're done
      if (sourceTimeMs < trim.startMs) {
        break;
      }

      // Add the duration of this trim region to the source time
      const trimDuration = trim.endMs - trim.startMs;
      sourceTimeMs += trimDuration;
    }

    return sourceTimeMs;
  }

  async export(): Promise<ExportResult> {
    try {
      this.cleanup();
      this.cancelled = false;

      // Initialize decoder and load video
      this.decoder = new VideoFileDecoder();
      const videoInfo = await this.decoder.loadVideo(this.config.videoUrl);

      // Initialize frame renderer
      this.renderer = new FrameRenderer({
        width: this.config.width,
        height: this.config.height,
        wallpaper: this.config.wallpaper,
        zoomRegions: this.config.zoomRegions,
        showShadow: this.config.showShadow,
        shadowIntensity: this.config.shadowIntensity,
        showBlur: this.config.showBlur,
        motionBlurEnabled: this.config.motionBlurEnabled,
        borderRadius: this.config.borderRadius,
        padding: this.config.padding,
        cropRegion: this.config.cropRegion,
        videoWidth: videoInfo.width,
        videoHeight: videoInfo.height,
        annotationRegions: this.config.annotationRegions,
        previewWidth: this.config.previewWidth,
        previewHeight: this.config.previewHeight,
      });
      await this.renderer.initialize();

      // Initialize video encoder
      await this.initializeEncoder();

      // Extract audio from source video
      await this.extractAudio();

      // Initialize audio encoder if we have audio
      if (this.hasAudio) {
        await this.initializeAudioEncoder();
      }

      // Initialize muxer with audio support
      this.muxer = new VideoMuxer(this.config, this.hasAudio);
      await this.muxer.initialize();

      // Calculate effective duration and frame count (excluding trim regions)
      const effectiveDuration = this.getEffectiveDuration(videoInfo.duration);
      const totalFrames = Math.ceil(effectiveDuration * this.config.frameRate);
      
      console.log('[VideoExporter] Original duration:', videoInfo.duration, 's');
      console.log('[VideoExporter] Effective duration:', effectiveDuration, 's');
      console.log('[VideoExporter] Total frames to export:', totalFrames);

      // Build playback segments (parts of video to include, excluding trims)
      const segments = this.buildPlaybackSegments(videoInfo.duration);
      console.log('[VideoExporter] Processing', segments.length, 'segment(s)');

      const frameDuration = 1_000_000 / this.config.frameRate; // in microseconds
      const frameIntervalMs = 1000 / this.config.frameRate;
      let outputFrameIndex = 0;

      // Process each segment by seeking to each frame timestamp
      for (let segIdx = 0; segIdx < segments.length && !this.cancelled; segIdx++) {
        const segment = segments[segIdx];
        console.log(`[VideoExporter] Segment ${segIdx + 1}: ${segment.startMs}ms - ${segment.endMs}ms`);

        // Calculate frames for this segment
        const segmentDurationMs = segment.endMs - segment.startMs;
        const segmentFrameCount = Math.ceil(segmentDurationMs / frameIntervalMs);

        for (let frameIdx = 0; frameIdx < segmentFrameCount && !this.cancelled; frameIdx++) {
          const sourceTimeMs = segment.startMs + (frameIdx * frameIntervalMs);
          
          // Don't go past segment end
          if (sourceTimeMs >= segment.endMs) break;

          const outputTimestamp = outputFrameIndex * frameDuration;

          // Get frame from decoder
          const videoFrame = await this.decoder!.getFrameAt(sourceTimeMs);
          if (!videoFrame) {
            console.warn(`[VideoExporter] Failed to get VideoFrame at ${sourceTimeMs}ms`);
            continue;
          }

          // Render frame with effects
          const sourceTimestamp = sourceTimeMs * 1000; // convert to microseconds
          await this.renderer!.renderFrame(videoFrame, sourceTimestamp);
          videoFrame.close();

          // Create export frame from rendered canvas
          const canvas = this.renderer!.getCanvas();
          // @ts-ignore
          const exportFrame = new VideoFrame(canvas, {
            timestamp: outputTimestamp,
            duration: frameDuration,
            colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true },
          });

          // Encode
          await this.waitForEncoderQueue();
          if (this.encoder?.state === 'configured') {
            this.encodeQueue++;
            this.encoder.encode(exportFrame, { keyFrame: outputFrameIndex % 150 === 0 });
          }
          exportFrame.close();

          outputFrameIndex++;

          // Update progress
          if (this.config.onProgress) {
            this.config.onProgress({
              currentFrame: outputFrameIndex,
              totalFrames,
              percentage: (outputFrameIndex / totalFrames) * 100,
              estimatedTimeRemaining: 0,
            });
          }
        }
      }

      if (this.cancelled) {
        return { success: false, error: 'Export cancelled' };
      }

      // Finalize video encoding
      if (this.encoder && this.encoder.state === 'configured') {
        await this.encoder.flush();
      }

      // Encode audio (using the same segments to respect trim regions)
      if (this.hasAudio) {
        await this.encodeAudio(segments);
      }

      // Wait for all muxing operations to complete
      await Promise.all(this.muxingPromises);

      // Finalize muxer and get output blob
      const blob = await this.muxer!.finalize();

      return { success: true, blob };
    } catch (error) {
      console.error('Export error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.cleanup();
    }
  }

  private async initializeEncoder(): Promise<void> {
    this.encodeQueue = 0;
    this.muxingPromises = [];
    this.chunkCount = 0;
    let videoDescription: Uint8Array | undefined;

    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        // Capture decoder config metadata from encoder output
        if (meta?.decoderConfig?.description && !videoDescription) {
          const desc = meta.decoderConfig.description;
          videoDescription = new Uint8Array(desc instanceof ArrayBuffer ? desc : (desc as any));
          this.videoDescription = videoDescription;
        }
        // Capture colorSpace from encoder metadata if provided
        if (meta?.decoderConfig?.colorSpace && !this.videoColorSpace) {
          this.videoColorSpace = meta.decoderConfig.colorSpace;
        }

        // Stream chunk to muxer immediately (parallel processing)
        const isFirstChunk = this.chunkCount === 0;
        this.chunkCount++;

        const muxingPromise = (async () => {
          try {
            if (isFirstChunk && this.videoDescription) {
              // Add decoder config for the first chunk
              const colorSpace = this.videoColorSpace || {
                primaries: 'bt709',
                transfer: 'iec61966-2-1',
                matrix: 'rgb',
                fullRange: true,
              };

              const metadata: EncodedVideoChunkMetadata = {
                decoderConfig: {
                  codec: this.config.codec || 'avc1.640033',
                  codedWidth: this.config.width,
                  codedHeight: this.config.height,
                  description: this.videoDescription,
                  colorSpace,
                },
              };

              await this.muxer!.addVideoChunk(chunk, metadata);
            } else {
              await this.muxer!.addVideoChunk(chunk, meta);
            }
          } catch (error) {
            console.error('Muxing error:', error);
          }
        })();

        this.muxingPromises.push(muxingPromise);
        this.encodeQueue--;
        // Signal that encoder queue has space
        this.signalEncoderQueueSpace();
      },
      error: (error) => {
        console.error('[VideoExporter] Encoder error:', error);
        // Stop export encoding failed
        this.cancelled = true;
      },
    });

    const codec = this.config.codec || 'avc1.640033';
    
    const encoderConfig: VideoEncoderConfig = {
      codec,
      width: this.config.width,
      height: this.config.height,
      bitrate: this.config.bitrate,
      framerate: this.config.frameRate,
      latencyMode: 'realtime',
      bitrateMode: 'variable',
      hardwareAcceleration: 'prefer-hardware',
    };

    // Check hardware support first
    const hardwareSupport = await VideoEncoder.isConfigSupported(encoderConfig);

    if (hardwareSupport.supported) {
      // Use hardware encoding
      console.log('[VideoExporter] Using hardware acceleration');
      this.encoder.configure(encoderConfig);
    } else {
      // Fall back to software encoding
      console.log('[VideoExporter] Hardware not supported, using software encoding');
      encoderConfig.hardwareAcceleration = 'prefer-software';
      
      const softwareSupport = await VideoEncoder.isConfigSupported(encoderConfig);
      if (!softwareSupport.supported) {
        throw new Error('Video encoding not supported on this system');
      }
      
      this.encoder.configure(encoderConfig);
    }
  }

  private async extractAudio(): Promise<void> {
    try {
      console.log('[VideoExporter] Extracting audio from source video...');
      
      // Fetch the video file as ArrayBuffer
      const response = await fetch(this.config.videoUrl);
      const arrayBuffer = await response.arrayBuffer();
      
      // Decode audio using Web Audio API
      const audioContext = new AudioContext();
      try {
        this.audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        this.hasAudio = this.audioBuffer.numberOfChannels > 0;
        console.log('[VideoExporter] Audio extracted:', {
          channels: this.audioBuffer.numberOfChannels,
          sampleRate: this.audioBuffer.sampleRate,
          duration: this.audioBuffer.duration,
        });
      } catch (e) {
        console.log('[VideoExporter] No audio track in video or failed to decode:', e);
        this.hasAudio = false;
      } finally {
        await audioContext.close();
      }
    } catch (e) {
      console.warn('[VideoExporter] Failed to extract audio:', e);
      this.hasAudio = false;
    }
  }

  private async initializeAudioEncoder(): Promise<void> {
    if (!this.audioBuffer) return;

    this.audioChunkCount = 0;

    this.audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        const isFirstChunk = this.audioChunkCount === 0;
        this.audioChunkCount++;

        const muxingPromise = (async () => {
          try {
            if (isFirstChunk) {
              const metadata: EncodedAudioChunkMetadata = {
                decoderConfig: {
                  codec: 'opus',
                  sampleRate: 48000,
                  numberOfChannels: 2,
                },
              };
              await this.muxer!.addAudioChunk(chunk, metadata);
            } else {
              await this.muxer!.addAudioChunk(chunk, meta);
            }
          } catch (error) {
            console.error('[VideoExporter] Audio muxing error:', error);
          }
        })();

        this.muxingPromises.push(muxingPromise);
      },
      error: (error) => {
        console.error('[VideoExporter] Audio encoder error:', error);
      },
    });

    const audioConfig: AudioEncoderConfig = {
      codec: 'opus',
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: 128000,
    };

    const support = await AudioEncoder.isConfigSupported(audioConfig);
    if (!support.supported) {
      console.warn('[VideoExporter] Opus audio encoding not supported, trying AAC');
      // Try AAC as fallback
      audioConfig.codec = 'mp4a.40.2';
      const aacSupport = await AudioEncoder.isConfigSupported(audioConfig);
      if (!aacSupport.supported) {
        console.warn('[VideoExporter] Audio encoding not supported, proceeding without audio');
        this.hasAudio = false;
        return;
      }
    }

    this.audioEncoder.configure(audioConfig);
    console.log('[VideoExporter] Audio encoder initialized');
  }

  private async encodeAudio(segments: Array<{ startMs: number; endMs: number }>): Promise<void> {
    if (!this.audioBuffer || !this.audioEncoder || !this.hasAudio) return;

    console.log('[VideoExporter] Encoding audio...');
    const sampleRate = this.audioBuffer.sampleRate;
    const numberOfChannels = this.audioBuffer.numberOfChannels;
    
    // Target sample rate for output (matching encoder config)
    const targetSampleRate = 48000;
    const targetChannels = 2;
    
    let outputTimestampUs = 0;

    for (const segment of segments) {
      const startSample = Math.floor((segment.startMs / 1000) * sampleRate);
      const endSample = Math.floor((segment.endMs / 1000) * sampleRate);
      const segmentSamples = endSample - startSample;
      
      if (segmentSamples <= 0) continue;

      // Extract audio data for this segment
      const channelData: Float32Array[] = [];
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const fullChannel = this.audioBuffer.getChannelData(ch);
        channelData.push(fullChannel.slice(startSample, endSample));
      }

      // Resample if necessary and convert to target format
      const resampleRatio = targetSampleRate / sampleRate;
      const outputSamples = Math.floor(segmentSamples * resampleRatio);
      
      // Create interleaved audio data for AudioData
      const outputData = new Float32Array(outputSamples * targetChannels);
      
      for (let i = 0; i < outputSamples; i++) {
        const srcIndex = Math.floor(i / resampleRatio);
        for (let ch = 0; ch < targetChannels; ch++) {
          const srcChannel = ch < numberOfChannels ? ch : 0; // Mono to stereo: duplicate
          const value = channelData[srcChannel][Math.min(srcIndex, channelData[srcChannel].length - 1)] || 0;
          outputData[i * targetChannels + ch] = value;
        }
      }

      // Encode in chunks (960 samples per frame for Opus at 48kHz = 20ms)
      const samplesPerFrame = 960;
      const framesInSegment = Math.ceil(outputSamples / samplesPerFrame);
      
      for (let frameIdx = 0; frameIdx < framesInSegment; frameIdx++) {
        const frameStart = frameIdx * samplesPerFrame;
        const frameEnd = Math.min(frameStart + samplesPerFrame, outputSamples);
        const frameSamples = frameEnd - frameStart;
        
        if (frameSamples <= 0) continue;

        // Create frame data
        const frameData = new Float32Array(samplesPerFrame * targetChannels);
        for (let i = 0; i < frameSamples * targetChannels; i++) {
          frameData[i] = outputData[frameStart * targetChannels + i] || 0;
        }

        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate: targetSampleRate,
          numberOfFrames: samplesPerFrame,
          numberOfChannels: targetChannels,
          timestamp: outputTimestampUs,
          data: this.interleavedToPlanar(frameData, targetChannels, samplesPerFrame).buffer as ArrayBuffer,
        });

        this.audioEncoder.encode(audioData);
        audioData.close();

        outputTimestampUs += (samplesPerFrame / targetSampleRate) * 1_000_000;
      }
    }

    // Flush audio encoder
    if (this.audioEncoder.state === 'configured') {
      await this.audioEncoder.flush();
    }
    console.log('[VideoExporter] Audio encoding complete');
  }

  private interleavedToPlanar(interleaved: Float32Array, channels: number, frames: number): Float32Array {
    const planar = new Float32Array(channels * frames);
    for (let ch = 0; ch < channels; ch++) {
      for (let i = 0; i < frames; i++) {
        planar[ch * frames + i] = interleaved[i * channels + ch] || 0;
      }
    }
    return planar;
  }

  cancel(): void {
    this.cancelled = true;
    this.cleanup();
  }

  private cleanup(): void {
    if (this.encoder) {
      try {
        if (this.encoder.state === 'configured') {
          this.encoder.close();
        }
      } catch (e) {
        console.warn('Error closing encoder:', e);
      }
      this.encoder = null;
    }

    if (this.audioEncoder) {
      try {
        if (this.audioEncoder.state === 'configured') {
          this.audioEncoder.close();
        }
      } catch (e) {
        console.warn('Error closing audio encoder:', e);
      }
      this.audioEncoder = null;
    }

    if (this.decoder) {
      try {
        this.decoder.destroy();
      } catch (e) {
        console.warn('Error destroying decoder:', e);
      }
      this.decoder = null;
    }

    if (this.renderer) {
      try {
        this.renderer.destroy();
      } catch (e) {
        console.warn('Error destroying renderer:', e);
      }
      this.renderer = null;
    }

    this.muxer = null;
    this.encodeQueue = 0;
    this.muxingPromises = [];
    this.chunkCount = 0;
    this.audioChunkCount = 0;
    this.videoDescription = undefined;
    this.videoColorSpace = undefined;
    this.audioBuffer = null;
    this.hasAudio = false;
    // Clear any pending queue resolvers
    this.encodeQueueResolvers.forEach(resolve => resolve());
    this.encodeQueueResolvers = [];
  }
}
