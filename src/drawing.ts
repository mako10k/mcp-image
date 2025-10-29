// Simple drawing command interpreter using Canvas API

import { createCanvas, Canvas, CanvasRenderingContext2D, Image, loadImage } from 'canvas';

export interface DrawingCommand {
  type: string;
  [key: string]: unknown;
}

export interface DrawingContext {
  canvas: Canvas;
  ctx: CanvasRenderingContext2D;
  figures: Map<string, Path2D | any>;
}

export async function executeDrawingCommands(
  commands: DrawingCommand[],
  width: number = 512,
  height: number = 512
): Promise<Buffer> {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  
  const drawingCtx: DrawingContext = {
    canvas,
    ctx,
    figures: new Map(),
  };

  // Set default styles
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;

  for (const cmd of commands) {
    await executeCommand(drawingCtx, cmd);
  }

  return canvas.toBuffer('image/png');
}

async function executeCommand(ctx: DrawingContext, cmd: DrawingCommand): Promise<void> {
  switch (cmd.type) {
    case 'line':
      drawLine(ctx.ctx, cmd);
      break;
    case 'curve':
    case 'spline':
      drawCurve(ctx.ctx, cmd);
      break;
    case 'rect':
      drawRect(ctx.ctx, cmd);
      break;
    case 'circle':
      drawCircle(ctx.ctx, cmd);
      break;
    case 'ellipse':
      drawEllipse(ctx.ctx, cmd);
      break;
    case 'polygon':
      drawPolygon(ctx.ctx, cmd);
      break;
    case 'fill':
      setFillStyle(ctx.ctx, cmd);
      break;
    case 'stroke':
      setStrokeStyle(ctx.ctx, cmd);
      break;
    case 'lineWidth':
      ctx.ctx.lineWidth = Number(cmd.width ?? 1);
      break;
    case 'text':
      drawText(ctx.ctx, cmd);
      break;
    case 'image':
      await drawImage(ctx.ctx, cmd);
      break;
    case 'transform':
      applyTransform(ctx.ctx, cmd);
      break;
    case 'save':
      ctx.ctx.save();
      break;
    case 'restore':
      ctx.ctx.restore();
      break;
    case 'beginPath':
      ctx.ctx.beginPath();
      break;
    case 'closePath':
      ctx.ctx.closePath();
      break;
    case 'fillPath':
      ctx.ctx.fill();
      break;
    case 'strokePath':
      ctx.ctx.stroke();
      break;
    case 'clearRect':
      ctx.ctx.clearRect(
        Number(cmd.x ?? 0),
        Number(cmd.y ?? 0),
        Number(cmd.width ?? 0),
        Number(cmd.height ?? 0)
      );
      break;
    default:
      console.warn(`Unknown drawing command: ${cmd.type}`);
  }
}

function drawLine(ctx: CanvasRenderingContext2D, cmd: DrawingCommand): void {
  ctx.beginPath();
  ctx.moveTo(Number(cmd.x1 ?? 0), Number(cmd.y1 ?? 0));
  ctx.lineTo(Number(cmd.x2 ?? 0), Number(cmd.y2 ?? 0));
  ctx.stroke();
}

function drawCurve(ctx: CanvasRenderingContext2D, cmd: DrawingCommand): void {
  const points = cmd.points as number[][];
  if (!points || points.length < 2) return;

  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);

  if (points.length === 3) {
    // Quadratic curve
    ctx.quadraticCurveTo(
      points[1][0], points[1][1],
      points[2][0], points[2][1]
    );
  } else if (points.length === 4) {
    // Bezier curve
    ctx.bezierCurveTo(
      points[1][0], points[1][1],
      points[2][0], points[2][1],
      points[3][0], points[3][1]
    );
  } else {
    // Catmull-Rom spline approximation
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i][0], points[i][1]);
    }
  }

  if (cmd.fill) {
    ctx.fill();
  } else {
    ctx.stroke();
  }
}

function drawRect(ctx: CanvasRenderingContext2D, cmd: DrawingCommand): void {
  const x = Number(cmd.x ?? 0);
  const y = Number(cmd.y ?? 0);
  const width = Number(cmd.width ?? 0);
  const height = Number(cmd.height ?? 0);

  if (cmd.fill !== false) {
    ctx.fillRect(x, y, width, height);
  }
  if (cmd.stroke !== false) {
    ctx.strokeRect(x, y, width, height);
  }
}

function drawCircle(ctx: CanvasRenderingContext2D, cmd: DrawingCommand): void {
  const x = Number(cmd.x ?? 0);
  const y = Number(cmd.y ?? 0);
  const radius = Number(cmd.radius ?? 0);

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  
  if (cmd.fill !== false) {
    ctx.fill();
  }
  if (cmd.stroke !== false) {
    ctx.stroke();
  }
}

function drawEllipse(ctx: CanvasRenderingContext2D, cmd: DrawingCommand): void {
  const x = Number(cmd.x ?? 0);
  const y = Number(cmd.y ?? 0);
  const radiusX = Number(cmd.radiusX ?? 0);
  const radiusY = Number(cmd.radiusY ?? 0);
  const rotation = Number(cmd.rotation ?? 0);

  ctx.beginPath();
  ctx.ellipse(x, y, radiusX, radiusY, rotation, 0, Math.PI * 2);
  
  if (cmd.fill !== false) {
    ctx.fill();
  }
  if (cmd.stroke !== false) {
    ctx.stroke();
  }
}

function drawPolygon(ctx: CanvasRenderingContext2D, cmd: DrawingCommand): void {
  const points = cmd.points as number[][];
  if (!points || points.length < 3) return;

  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i][0], points[i][1]);
  }
  ctx.closePath();

  if (cmd.fill !== false) {
    ctx.fill();
  }
  if (cmd.stroke !== false) {
    ctx.stroke();
  }
}

function setFillStyle(ctx: CanvasRenderingContext2D, cmd: DrawingCommand): void {
  if (cmd.color) {
    ctx.fillStyle = String(cmd.color);
  } else if (cmd.gradient) {
    const grad = cmd.gradient as any;
    let gradient;
    
    if (grad.type === 'linear') {
      gradient = ctx.createLinearGradient(
        grad.x0 ?? 0, grad.y0 ?? 0,
        grad.x1 ?? 0, grad.y1 ?? 0
      );
    } else if (grad.type === 'radial') {
      gradient = ctx.createRadialGradient(
        grad.x0 ?? 0, grad.y0 ?? 0, grad.r0 ?? 0,
        grad.x1 ?? 0, grad.y1 ?? 0, grad.r1 ?? 0
      );
    } else {
      return;
    }

    if (grad.stops) {
      for (const stop of grad.stops as any[]) {
        gradient.addColorStop(stop.offset, stop.color);
      }
    }

    ctx.fillStyle = gradient;
  }
}

function setStrokeStyle(ctx: CanvasRenderingContext2D, cmd: DrawingCommand): void {
  if (cmd.color) {
    ctx.strokeStyle = String(cmd.color);
  }
  if (cmd.width !== undefined) {
    ctx.lineWidth = Number(cmd.width);
  }
  if (cmd.cap) {
    ctx.lineCap = String(cmd.cap) as CanvasLineCap;
  }
  if (cmd.join) {
    ctx.lineJoin = String(cmd.join) as CanvasLineJoin;
  }
}

function drawText(ctx: CanvasRenderingContext2D, cmd: DrawingCommand): void {
  const text = String(cmd.text ?? '');
  const x = Number(cmd.x ?? 0);
  const y = Number(cmd.y ?? 0);

  if (cmd.font) {
    ctx.font = String(cmd.font);
  }
  if (cmd.align) {
    ctx.textAlign = String(cmd.align) as CanvasTextAlign;
  }
  if (cmd.baseline) {
    ctx.textBaseline = String(cmd.baseline) as CanvasTextBaseline;
  }

  if (cmd.stroke) {
    ctx.strokeText(text, x, y);
  } else {
    ctx.fillText(text, x, y);
  }
}

async function drawImage(ctx: CanvasRenderingContext2D, cmd: DrawingCommand): Promise<void> {
  try {
    const src = String(cmd.src ?? '');
    const image = await loadImage(src);
    
    const x = Number(cmd.x ?? 0);
    const y = Number(cmd.y ?? 0);
    const width = cmd.width !== undefined ? Number(cmd.width) : image.width;
    const height = cmd.height !== undefined ? Number(cmd.height) : image.height;

    ctx.drawImage(image, x, y, width, height);
  } catch (error) {
    console.warn(`Failed to load image: ${error}`);
  }
}

function applyTransform(ctx: CanvasRenderingContext2D, cmd: DrawingCommand): void {
  if (cmd.translate) {
    const t = cmd.translate as number[];
    ctx.translate(t[0] ?? 0, t[1] ?? 0);
  }
  if (cmd.rotate) {
    ctx.rotate(Number(cmd.rotate));
  }
  if (cmd.scale) {
    const s = cmd.scale as number[];
    if (Array.isArray(s)) {
      ctx.scale(s[0] ?? 1, s[1] ?? s[0] ?? 1);
    } else {
      ctx.scale(Number(s), Number(s));
    }
  }
  if (cmd.matrix) {
    const m = cmd.matrix as number[];
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  }
}
