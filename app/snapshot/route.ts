import path from "path";
import { spawn } from "child_process";
import fs from "fs/promises";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

interface SnapshotRequest {
  url: string;
  timestamp: number;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: SnapshotRequest;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { url, timestamp } = body;

  if (!url || typeof url !== "string") {
    return NextResponse.json(
      { error: "Missing or invalid 'url' parameter" },
      { status: 400 }
    );
  }

  if (typeof timestamp !== "number" || timestamp < 0 || !Number.isFinite(timestamp)) {
    return NextResponse.json(
      { error: "Missing or invalid 'timestamp' parameter (must be a non-negative number in seconds)" },
      { status: 400 }
    );
  }

  // Use system ffmpeg for HTTP input (ffmpeg-static SIGSEGVs on HTTP)
  const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";

  let inputPath: string;
  if (url.startsWith("file://")) {
    const filePath = decodeURIComponent(url.slice(7));
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(process.cwd()) && !resolved.startsWith("/tmp")) {
      return NextResponse.json(
        { error: "file:// URLs must be within project or /tmp" },
        { status: 400 }
      );
    }
    try {
      await fs.access(resolved);
    } catch {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    inputPath = resolved;
  } else {
    inputPath = url;
  }

  try {
    // -ss before -i for fast input seeking
    // -vframes 1 to output a single frame
    // -f image2 -c:v png for PNG output
    const ffmpegArgs = [
      "-ss",
      String(timestamp),
      "-i",
      inputPath,
      "-vframes",
      "1",
      "-f",
      "image2",
      "-c:v",
      "png",
      "pipe:1",
    ];

    const imageBuffer = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let stderr = "";
      const proc = spawn(ffmpegPath, ffmpegArgs, { stdio: ["ignore", "pipe", "pipe"] });

      proc.stdout.on("data", (data: Buffer) => chunks.push(data));
      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code, signal) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(
            new Error(
              `FFmpeg failed: code=${code} signal=${signal ?? "none"}\n${stderr.slice(-500)}`
            )
          );
        }
      });

      proc.on("error", reject);
    });

    if (imageBuffer.length === 0) {
      return NextResponse.json(
        { error: "Failed to extract frame (empty output). Check that the URL is valid and the timestamp is within the video duration." },
        { status: 422 }
      );
    }

    return new NextResponse(Buffer.from(imageBuffer), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(imageBuffer.length),
      },
    });
  } catch (error) {
    console.error("Snapshot error:", error);

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";

    return NextResponse.json(
      {
        error: "Failed to extract snapshot",
        details: errorMessage,
      },
      { status: 500 }
    );
  }
}
