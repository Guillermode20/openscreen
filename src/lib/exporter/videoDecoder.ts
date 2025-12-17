import * as MP4BoxModule from 'mp4box';
const MP4Box = (MP4BoxModule as any).default || MP4BoxModule;

export interface DecodedVideoInfo {
  width: number;
  height: number;
  duration: number; // in seconds
  frameRate: number;
  codec: string;
}

export class VideoFileDecoder {
  private info: DecodedVideoInfo | null = null;
  private mp4boxFile: any = null;
  private videoTrack: any = null;
  private decoder: VideoDecoder | null = null;
  private samples: any[] = [];
  private currentSampleIdx = 0;
  private frameQueue: VideoFrame[] = [];
  private frameResolvers: ((frame: VideoFrame | null) => void)[] = [];
  private isConfigured = false;
  private firstSampleCTS: number = 0;

  async loadVideo(videoUrl: string): Promise<DecodedVideoInfo> {
    const response = await fetch(videoUrl);
    const arrayBuffer = await response.arrayBuffer();
    
    this.mp4boxFile = MP4Box.createFile();
    
    return new Promise((resolve, reject) => {
      this.mp4boxFile.onReady = (info: any) => {
        this.videoTrack = info.videoTracks[0];
        if (!this.videoTrack) {
          reject(new Error('No video track found in the file'));
          return;
        }

        this.info = {
          width: this.videoTrack.track_width,
          height: this.videoTrack.track_height,
          duration: info.duration / info.timescale,
          frameRate: this.videoTrack.nb_samples / (info.duration / info.timescale) || 30,
          codec: this.videoTrack.codec,
        };

        // Configure extraction
        this.mp4boxFile.setExtractionOptions(this.videoTrack.id, null, { nbSamples: 1000000 });
        
        this.mp4boxFile.onSamples = (id: number, user: any, samples: any[]) => {
          if (id === this.videoTrack.id) {
            this.samples.push(...samples);
          }
        };

        this.mp4boxFile.start();

        // Wait a bit for samples to start arriving
        setTimeout(() => {
          this.initializeDecoder().then(() => {
            resolve(this.info!);
          }).catch(reject);
        }, 100);
      };

      this.mp4boxFile.onError = (e: string) => {
        reject(new Error(`MP4Box error: ${e}`));
      };

      // @ts-ignore
      arrayBuffer.fileStart = 0;
      this.mp4boxFile.appendBuffer(arrayBuffer);
      this.mp4boxFile.flush();
    });
  }

  private async initializeDecoder(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.decoder = new VideoDecoder({
        output: (frame) => {
          if (this.frameResolvers.length > 0) {
            const resolver = this.frameResolvers.shift();
            resolver?.(frame);
          } else {
            this.frameQueue.push(frame);
          }
        },
        error: (e) => {
          console.error('[VideoFileDecoder] Decoder error:', e);
        },
      });

      const config: VideoDecoderConfig = {
        codec: this.videoTrack.codec.startsWith('vp09') ? 'vp09.00.10.08' : this.videoTrack.codec,
        codedWidth: this.videoTrack.track_width,
        codedHeight: this.videoTrack.track_height,
        description: this.getExtraData(),
        hardwareAcceleration: 'prefer-hardware',
      };

      VideoDecoder.isConfigSupported(config).then((support) => {
        if (support.supported) {
          this.decoder?.configure(config);
          this.isConfigured = true;
          resolve();
        } else {
          reject(new Error(`Video codec not supported: ${config.codec}`));
        }
      }).catch(reject);
    });
  }

  private getExtraData(): Uint8Array | undefined {
    const trak = this.mp4boxFile.moov.traks.find((t: any) => t.tkhd.track_id === this.videoTrack.id);
    if (!trak) return undefined;

    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (!box) return undefined;

    // @ts-ignore
    const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
    box.write(stream);
    return new Uint8Array(stream.buffer, 8);
  }

  async getFrameAt(timeMs: number): Promise<VideoFrame | null> {
    const timeUs = timeMs * 1000;

    // 1. Clean up old frames
    while (this.frameQueue.length > 1 && this.frameQueue[1].timestamp <= timeUs) {
      const oldFrame = this.frameQueue.shift();
      oldFrame?.close();
    }

    // 2. Decode until we have a frame that covers the requested time
    // We need at least one frame, and if we have frames, the last one should be >= timeUs
    // OR we've run out of samples.
    while (this.frameQueue.length === 0 || this.frameQueue[this.frameQueue.length - 1].timestamp < timeUs) {
      const frame = await this.decodeNext();
      if (!frame) break; // End of stream
      
      // If this new frame is still before timeUs, and we have an older one, discard the older one
      // to keep the queue small. We only need the frame immediately before or at timeUs.
      if (this.frameQueue.length > 0 && frame.timestamp <= timeUs) {
        const oldFrame = this.frameQueue.shift();
        oldFrame?.close();
      }
      this.frameQueue.push(frame);
    }

    if (this.frameQueue.length === 0) return null;

    // Return the frame that is closest to timeUs without going over, 
    // or the first frame if timeUs is before the first frame.
    return this.frameQueue[0].clone();
  }

  private async decodeNext(): Promise<VideoFrame | null> {
    if (this.currentSampleIdx >= this.samples.length) {
      return null;
    }

    if (this.currentSampleIdx === 0 && this.samples.length > 0) {
      this.firstSampleCTS = this.samples[0].cts;
    }

    return new Promise((resolve) => {
      this.frameResolvers.push(resolve);
      
      // Feed ONE sample at a time to avoid consuming all samples before frames are produced
      const sample = this.samples[this.currentSampleIdx++];
      
      const chunk = new EncodedVideoChunk({
        type: sample.is_sync ? 'key' : 'delta',
        timestamp: ((sample.cts - this.firstSampleCTS) * 1_000_000) / sample.timescale,
        duration: (sample.duration * 1_000_000) / sample.timescale,
        data: sample.data,
      });

      try {
        this.decoder?.decode(chunk);
      } catch (e) {
        console.error('[VideoFileDecoder] Decode error:', e);
        this.frameResolvers.shift()?.(null);
      }
    });
  }

  getInfo(): DecodedVideoInfo | null {
    return this.info;
  }

  destroy(): void {
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.close();
      } catch (e) {}
    }
    this.decoder = null;
    this.frameQueue.forEach(f => f.close());
    this.frameQueue = [];
    this.samples = [];
    this.mp4boxFile = null;
    this.frameResolvers.forEach(r => r(null));
    this.frameResolvers = [];
  }
}
