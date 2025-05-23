/**
 * @typedef {import("../types.js").Token} Token
 * @typedef {import("../types.js").ClipToken} ClipToken
 * @typedef {import("../types.js").TransformToken} TransformToken
 * @typedef {import("../types.js").FillToken} FillToken
 * @typedef {import("../types.js").TextToken} TextToken
 * @typedef {import("../types.js").ImageToken} ImageToken
 */

import { createPath2d } from "./path.js";
import { supportsCanvasBlur, blur } from "./blur.js";
import { VerticalTextRenderer } from "./vertical-text.js";

const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const textOffsetY = isSafari ? -1 : 1;
const underlineOffset = isSafari ? 0.5 : -2.5;

export function render(tokens, options = {}) {
	const { width, height, scale } = options;

	const createCanvas = (existingCanvas) => {
		const canvas = existingCanvas ?? document.createElement("canvas");
		canvas.width = width * scale;
		canvas.height = height * scale;
		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;

		const ctx = canvas.getContext("2d");
		if (!ctx) {
			throw new Error("Failed to get 2d context");
		}
		ctx.scale(scale, scale);

		return { canvas, ctx };
	};

	const rootLayer = createCanvas(options.canvas);
	const layers = [rootLayer];
	let { canvas, ctx } = rootLayer;

	const vtr = new VerticalTextRenderer(canvas.width, canvas.height, scale);

	for (const token of tokens) {
		switch (token.type) {
			case "effect": {
				ctx.save();
				if (token.opacity != null) {
					ctx.globalAlpha = token.opacity;
				}
				if (token.blendMode != null) {
					ctx.globalCompositeOperation = token.blendMode;
				}

				const newLayer = createCanvas();
				layers.push(newLayer);
				canvas = newLayer.canvas;
				ctx = newLayer.ctx;
				break;
			}
			case "endEffect": {
				const effectLayer = layers.pop();
				canvas = layers[layers.length - 1].canvas;
				ctx = layers[layers.length - 1].ctx;
				ctx.drawImage(effectLayer.canvas, 0, 0, width, height);
				ctx.restore();
				break;
			}
			case "clip":
				ctx.save();
				clip(ctx, token);
				break;
			case "transform":
				ctx.save();
				ctx.transform(...token.matrix);
				break;
			case "endClip":
			case "endTransform":
				ctx.restore();
				break;
			case "fill":
				fill(ctx, token, scale);
				break;
			case "text":
				text(ctx, token, scale, vtr);
				break;
			case "image":
				image(ctx, token, scale);
				break;
		}
	}

	if (vtr.initialized) {
		vtr.destroy();
	}

	return canvas;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {ClipToken} token
 */
function clip(ctx, token) {
	if (token.path) {
		const path2d = createPath2d(token.path);
		ctx.translate(token.x, token.y);
		ctx.clip(path2d, token.path.fillRule ?? "nonzero");
		ctx.translate(-token.x, -token.y);
		return;
	}
	if (token.rect) {
		ctx.beginPath();
		ctx.rect(token.x, token.y, token.rect.width, token.rect.height);
		ctx.clip();
	}
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {FillToken} token
 * @param {number} scale
 */
function fill(ctx, token, scale) {
	ctx.save();

	ctx.fillStyle = token.color;
	if (token.filter != null) {
		ctx.filter = token.filter;
	}

	const blurRadius = getBlurRadius(token.filter);
	let blurCanvas;
	let blurCtx;
	if (!supportsCanvasBlur() && blurRadius > 0) {
		blurCanvas = document.createElement("canvas");
		blurCanvas.width = token.rect.width * scale;
		blurCanvas.height = token.rect.height * scale;
		blurCtx = blurCanvas.getContext("2d");
		blurCtx.fillStyle = token.color;
		blurCtx.scale(scale, scale);
		blurCtx.translate(-token.rect.x, -token.rect.y);
	} else {
		ctx.translate(token.x, token.y);
	}

	const targetCtx = blurCtx ?? ctx;

	if (token.path) {
		const path2d = createPath2d(token.path);
		targetCtx.translate(0, 0);
		targetCtx.fill(path2d, token.path.fillRule ?? "nonzero");
	} else {
		targetCtx.beginPath();
		targetCtx.rect(0, 0, token.rect.width, token.rect.height);
		targetCtx.fill();
	}

	if (blurCtx) {
		blur(blurCanvas, blurRadius * scale);
		ctx.drawImage(
			blurCanvas,
			token.x + token.rect.x,
			token.y + token.rect.y,
			token.rect.width,
			token.rect.height,
		);
	}

	ctx.restore();
}

function getBlurRadius(filter) {
	const blurRadius = filter?.match(/blur\((\d+)px\)/)?.[1];
	if (!blurRadius) {
		return 0;
	}
	const radius = Number.parseInt(blurRadius);
	return Number.isNaN(radius) ? 0 : radius;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {TextToken} token
 * @param {number} scale
 * @param {VerticalTextRenderer} vtr
 */
function text(ctx, token, scale, vtr) {
	let draw = horizontalText;
	if (
		token.writingMode === "vertical-rl" ||
		token.writingMode === "vertical-lr"
	) {
		if (!vtr.initialized) {
			vtr.init();
		}
		draw = verticalText;
	}
	for (const shadow of token.textShadows.reverse()) {
		const blurTextToken = {
			...token,
			color: shadow.color,
			x: token.x + shadow.x,
			y: token.y + shadow.y,
		};
		const [blurCtx, finishBlur] = applyTextBlur(
			ctx,
			scale,
			shadow.blur,
			blurTextToken,
		);
		draw(blurCtx, blurTextToken, scale, vtr);
		finishBlur();
	}
	draw(ctx, token, scale, vtr);
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {TextToken} token
 * @param {number} scale
 */
function horizontalText(ctx, token, scale) {
	const text = prepareText(token);

	ctx.save();
	ctx.textBaseline = "top";
	ctx.fillStyle = token.color;
	ctx.font = token.font;
	ctx.fontKerning = token.fontKerning;
	ctx.fontStretch = token.fontStretch;
	ctx.fontVariantCaps = token.fontVariantCaps;
	ctx.letterSpacing = token.letterSpacing;
	ctx.textAlign = token.textAlign;
	const x = (() => {
		switch (token.textAlign) {
			case "center":
				return token.x + token.width / 2;
			case "right":
				return token.x + token.width;
			default:
				return token.x;
		}
	})();
	const y = token.y + (token.height - token.fontSize) / 2 + textOffsetY;
	const scaleX = token.scaleX ?? 1;

	ctx.transform(scaleX, 0, 0, 1, x, y);
	ctx.fillText(text, 0, 0);
	ctx.restore();

	ctx.save();
	const { textDecoration } = token;
	if (textDecoration) {
		ctx.strokeStyle = textDecoration.color;
		ctx.lineWidth = textDecoration.thickness;
		if (textDecoration.underline) {
			const y = token.y + token.height + underlineOffset;
			ctx.beginPath();
			ctx.moveTo(token.x, y);
			ctx.lineTo(token.x + token.width, y);
			ctx.stroke();
		}
	}
	ctx.restore();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {TextToken} token
 * @param {number} scale
 * @param {VerticalTextRenderer} vtr
 */
function verticalText(ctx, token, scale, vtr) {
	const text = prepareText(token);

	const x = token.x + token.width / 2;
	const y = (() => {
		switch (token.textAlign) {
			case "center":
				return token.y + token.height / 2;
			case "right":
				return token.y + token.height;
			default:
				return token.y;
		}
	})();
	const scaleX = token.scaleX ?? 1;
	const scaleY = 1;

	ctx.save();
	ctx.transform(scaleX / scale, 0, 0, scaleY / scale, x * (1 - scaleX), y * (1 - scaleY));
	ctx.fillStyle = "#fc0";
	ctx.fillRect(x - 1, y - 1, 2, 2);
	vtr.render(ctx, text, x, y, {
		fillStyle: token.color,
		font: token.font,
		fontKerning: token.fontKerning,
		fontStretch: token.fontStretch,
		fontVariantCaps: token.fontVariantCaps,
		letterSpacing: token.letterSpacing,
		textAlign: token.textAlign,
	});
	ctx.restore();
}

function prepareText(token) {
	const { text, whiteSpace } = token;
	if (
		whiteSpace === "pre" ||
		whiteSpace === "pre-wrap" ||
		whiteSpace === "break-spaces" ||
		whiteSpace === "preserve-spaces"
	) {
		return text.trim();
	}
	return text.replace(/\s+/g, " ");
}

function applyTextBlur(ctx, scale, radius, rect) {
	if (radius == null || radius === 0) {
		return [ctx, () => {}];
	}
	if (supportsCanvasBlur()) {
		ctx.save();
		ctx.filter = `blur(${radius}px)`;
		return [
			ctx,
			() => {
				ctx.restore();
			},
		];
	}
	const x = rect.x - radius;
	const y = rect.y - radius;
	const width = rect.width + radius * 2;
	const height = rect.height + radius * 2;
	const blurCanvas = document.createElement("canvas");
	blurCanvas.width = width * scale;
	blurCanvas.height = height * scale;
	const blurCtx = blurCanvas.getContext("2d");
	if (!blurCtx) {
		throw new Error("Failed to get 2d context");
	}
	blurCtx.scale(scale, scale);
	blurCtx.translate(-x, -y);
	return [
		blurCtx,
		() => {
			blur(blurCanvas, radius * scale);
			ctx.drawImage(blurCanvas, rect.x, rect.y, rect.width, rect.height);
		},
	];
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {ImageToken} token
 * @param {number} scale
 */
async function image(ctx, token, scale) {
	if (!token.fillColor) {
		ctx.drawImage(
			token.image,
			0,
			0,
			token.image.width,
			token.image.height,
			token.x,
			token.y,
			token.width,
			token.height,
		);
	} else {
		const canvas = document.createElement("canvas");
		canvas.width = token.width * scale;
		canvas.height = token.height * scale;
		const ctx2 = canvas.getContext("2d");
		if (!ctx2) {
			throw new Error("Failed to get 2d context");
		}
		ctx2.scale(scale, scale);
		ctx2.globalCompositeOperation = "source-over";
		ctx2.fillStyle = token.fillColor;
		ctx2.fillRect(0, 0, token.width, token.height);
		ctx2.globalCompositeOperation = "destination-in";
		ctx2.drawImage(
			token.image,
			0,
			0,
			token.image.width,
			token.image.height,
			0,
			0,
			token.width,
			token.height,
		);
		ctx.drawImage(canvas, token.x, token.y, token.width, token.height);
	}
}
