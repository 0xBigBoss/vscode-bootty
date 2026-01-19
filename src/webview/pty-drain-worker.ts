type ByteArray = Uint8Array<ArrayBufferLike>;

type DrainMessage = {
	type: "drain";
	terminalId: string;
	maxLines: number;
	maxFrameMs: number;
	maxBytes: number;
	minBytes: number;
	token: number;
};

type EnqueueMessage = {
	type: "enqueue";
	terminalId: string;
	data: ByteArray;
};

type ResetMessage = {
	type: "reset";
	terminalId: string;
};

type WorkerMessage = DrainMessage | EnqueueMessage | ResetMessage;

type QueueState = {
	queue: ByteArray[];
	bytes: number;
};

const EMPTY_CHUNK: ByteArray = new Uint8Array(0);
const WASM_MIN_BYTES = 4096;
const WASM_DRAIN_BASE64 =
	"AGFzbQEAAAABCAFgA39/fwF+AwIBAAUDAQABBx0CBm1lbW9yeQIAEGZpbmRfbnRoX25ld2xpbmUAAApTAVEBA39BACEDQQAhBEF/IQUCQANAIAMgAU8NASAEIAJPDQEgACADai0AAEEKRgRAIARBAWohBCADIQULIANBAWohAwwACwsgBK1CIIYgBa2EDws=";
const queues = new Map<string, QueueState>();
let wasmDrainModule: WasmDrainModule | null | undefined;

type WasmDrainModule = {
	memory: WebAssembly.Memory;
	findNthNewline: (ptr: number, len: number, max: number) => bigint;
};

function getState(terminalId: string): QueueState {
	let state = queues.get(terminalId);
	if (!state) {
		state = { queue: [], bytes: 0 };
		queues.set(terminalId, state);
	}
	return state;
}

function nowMs(): number {
	if (typeof performance !== "undefined" && performance.now) {
		return performance.now();
	}
	return Date.now();
}

function decodeBase64(base64: string): Uint8Array {
	if (typeof atob !== "function") {
		throw new Error("atob unavailable");
	}
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function getWasmDrainModule(): WasmDrainModule | null {
	if (wasmDrainModule !== undefined) return wasmDrainModule;
	try {
		if (typeof WebAssembly === "undefined") {
			wasmDrainModule = null;
			return wasmDrainModule;
		}
		const bytes = decodeBase64(WASM_DRAIN_BASE64);
		const module = new WebAssembly.Module(bytes as BufferSource);
		const instance = new WebAssembly.Instance(module, {});
		const exports = instance.exports as {
			memory?: WebAssembly.Memory;
			find_nth_newline?: (ptr: number, len: number, max: number) => bigint;
		};
		if (!exports.memory || typeof exports.find_nth_newline !== "function") {
			throw new Error("missing wasm exports");
		}
		wasmDrainModule = {
			memory: exports.memory,
			findNthNewline: exports.find_nth_newline,
		};
	} catch {
		wasmDrainModule = null;
	}
	return wasmDrainModule;
}

function splitBytesByLineCount(
	data: ByteArray,
	maxLines: number,
): { head: ByteArray; tail: ByteArray; lines: number } {
	if (maxLines <= 0) {
		return { head: data, tail: EMPTY_CHUNK, lines: 0 };
	}
	if (data.byteLength >= WASM_MIN_BYTES) {
		const wasm = getWasmDrainModule();
		if (wasm) {
			const required = data.byteLength;
			if (wasm.memory.buffer.byteLength < required) {
				const missing = required - wasm.memory.buffer.byteLength;
				const pages = Math.ceil(missing / 65536);
				if (pages > 0) {
					wasm.memory.grow(pages);
				}
			}
			const view = new Uint8Array(wasm.memory.buffer);
			view.set(data as ArrayLike<number>, 0);
			const result = wasm.findNthNewline(0, data.byteLength, maxLines);
			const offset = Number(result & 0xffffffffn);
			const lines = Number(result >> 32n);
			if (offset === 0xffffffff) {
				return { head: data, tail: EMPTY_CHUNK, lines: 0 };
			}
			const head = data.subarray(0, offset + 1);
			const tail = data.subarray(offset + 1);
			return { head, tail, lines };
		}
	}
	let lines = 0;
	let lastIndex = -1;
	for (let i = 0; i < data.length && lines < maxLines; i++) {
		if (data[i] === 0x0a) {
			lines += 1;
			lastIndex = i;
		}
	}
	if (lastIndex === -1) {
		return { head: data, tail: EMPTY_CHUNK, lines: 0 };
	}
	const head = data.subarray(0, lastIndex + 1);
	const tail = data.subarray(lastIndex + 1);
	return { head, tail, lines };
}

function drainQueue(
	state: QueueState,
	maxLines: number,
	maxFrameMs: number,
	maxBytes: number,
	minBytes: number,
): {
	output: ByteArray;
	drainedLines: number;
	drainedBytes: number;
	durationMs: number;
} {
	const targetBytes = maxBytes > 0 ? maxBytes : Math.max(0, minBytes);
	const minTarget =
		minBytes > 0 ? (maxBytes > 0 ? Math.min(minBytes, maxBytes) : minBytes) : 0;
	const useLineCap = targetBytes === 0;
	let remaining = useLineCap ? maxLines : 0;
	const chunks = useLineCap ? ([] as ByteArray[]) : null;
	let output = EMPTY_CHUNK;
	let outputOffset = 0;
	let outputBytes = 0;
	let drainedLines = 0;
	const start = nowMs();
	let didDrain = false;
	if (!useLineCap && targetBytes > 0 && state.bytes > 0) {
		output = new Uint8Array(Math.min(targetBytes, state.bytes));
	}
	while (
		state.queue.length > 0 &&
		(useLineCap ? remaining > 0 : outputBytes < targetBytes)
	) {
		if (maxFrameMs > 0 && didDrain && nowMs() - start >= maxFrameMs) {
			if (minTarget <= 0 || outputBytes >= minTarget) {
				break;
			}
		}
		const next = state.queue[0];
		if (next.length === 0) {
			state.queue.shift();
			continue;
		}
		let head = next;
		let tail = EMPTY_CHUNK;
		let lines = 0;
		if (useLineCap) {
			const split = splitBytesByLineCount(next, remaining);
			head = split.head;
			tail = split.tail;
			lines = split.lines;
		} else {
			const remainingBytes = targetBytes - outputBytes;
			if (remainingBytes <= 0) break;
			if (next.byteLength > remainingBytes) {
				head = next.subarray(0, remainingBytes);
				tail = next.subarray(remainingBytes);
			}
			lines = 0;
		}
		if (head.byteLength > 0) {
			if (useLineCap) {
				chunks?.push(head);
				outputBytes += head.byteLength;
			} else if (output.byteLength >= outputOffset + head.byteLength) {
				output.set(head, outputOffset);
				outputOffset += head.byteLength;
				outputBytes = outputOffset;
			}
		}
		drainedLines += lines;
		didDrain = true;
		if (tail.byteLength > 0) {
			state.queue[0] = tail;
		} else {
			state.queue.shift();
		}
		if (useLineCap) {
			remaining -= lines;
		}
		if (useLineCap && lines === 0 && maxFrameMs <= 0) {
			// No newline found; allow one chunk per flush to avoid blocking.
			break;
		}
	}
	if (useLineCap) {
		if (chunks && chunks.length === 1) {
			output = chunks[0];
		} else if (chunks && outputBytes > 0) {
			output = new Uint8Array(outputBytes);
			let offset = 0;
			for (const chunk of chunks) {
				output.set(chunk, offset);
				offset += chunk.byteLength;
			}
		} else {
			output = EMPTY_CHUNK;
		}
	} else if (outputBytes === 0) {
		output = EMPTY_CHUNK;
	} else if (outputBytes < output.byteLength) {
		output = output.subarray(0, outputBytes);
	}
	return {
		output,
		drainedLines,
		drainedBytes: outputBytes,
		durationMs: nowMs() - start,
	};
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
	const msg = event.data;
	switch (msg.type) {
		case "enqueue": {
			const state = getState(msg.terminalId);
			if (msg.data.byteLength > 0) {
				state.queue.push(msg.data);
				state.bytes += msg.data.byteLength;
			}
			break;
		}
		case "drain": {
			const state = getState(msg.terminalId);
			const queueSegmentsBefore = state.queue.length;
			const queueBytesBefore = state.bytes;
			const { output, drainedLines, drainedBytes, durationMs } = drainQueue(
				state,
				msg.maxLines,
				msg.maxFrameMs,
				msg.maxBytes,
				msg.minBytes,
			);
			state.bytes = Math.max(0, state.bytes - drainedBytes);
			const payload = {
				type: "drain-result",
				terminalId: msg.terminalId,
				token: msg.token,
				output,
				drainedLines,
				drainedBytes,
				durationMs,
				queueSegmentsBefore,
				queueSegmentsAfter: state.queue.length,
				queueBytesBefore,
				queueBytesAfter: state.bytes,
			};
			if (output.byteLength > 0) {
				self.postMessage(payload, { transfer: [output.buffer as ArrayBuffer] });
			} else {
				self.postMessage(payload);
			}
			break;
		}
		case "reset": {
			queues.delete(msg.terminalId);
			break;
		}
	}
};
