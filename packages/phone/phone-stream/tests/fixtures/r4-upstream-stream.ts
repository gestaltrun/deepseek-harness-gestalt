/**
 * Byte-exact reconstruction of the real mobilecli 1.0.5 capture stream shape
 * captured during acceptance R4 (sanitized): the body opens under the declared
 * `--BoundaryString` family carrying JSON notification parts, then mid-stream
 * switches to an undeclared `--mjpeg-frame-boundary` family for the image
 * frames. Chromium locks onto the declared boundary, so the dual-boundary body
 * never renders — the proxy normalizes it to one boundary.
 * @module fixtures/r4-upstream-stream
 */

/** Notification family boundary (declared in the content type). */
const R4_NOTIFICATION_BOUNDARY = 'BoundaryString'

/** Image family boundary (undeclared; appears mid-stream). */
const R4_FRAME_BOUNDARY = 'mjpeg-frame-boundary'

/** Canonical baseline 1×1 JPEG standing in for the captured 1206×2622 frames. */
export const R4_FRAME = Buffer.from(
  'ffd8ffe000104a46494600010101006000600000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffdb0043010909090c0b0c180d0d1832211c213232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232ffc00011080001000103012200021101031101ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda000c03010002110311003f00f7fa28a2803fffd9',
  'hex',
)

const JSON_NOTIFICATION = JSON.stringify({ notification: 'message', message: 'Starting video stream' })

function part(boundary: string, headers: string, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n`),
    payload,
    Buffer.from('\r\n'),
  ])
}

/**
 * The R4 upstream body verbatim: JSON notifications under the declared
 * boundary, then image frames under the undeclared frame boundary.
 */
export function buildR4UpstreamBody(frame: Buffer = R4_FRAME): Buffer {
  return Buffer.concat([
    part(R4_NOTIFICATION_BOUNDARY, 'Content-Type: application/json', Buffer.from(JSON_NOTIFICATION)),
    part(R4_NOTIFICATION_BOUNDARY, 'Content-Type: application/json', Buffer.from(JSON.stringify({ notification: 'progress', message: 'streaming' }))),
    part(R4_FRAME_BOUNDARY, `Content-Type: image/jpeg\r\nContent-Length: ${String(frame.length)}`, frame),
    part(R4_FRAME_BOUNDARY, `Content-Type: image/jpeg\r\nContent-Length: ${String(frame.length)}`, frame),
    Buffer.from(`--${R4_FRAME_BOUNDARY}--\r\n`),
  ])
}

/** Extreme: notifications only, the stream never reaches a frame. */
export function buildAllNotificationBody(): Buffer {
  return Buffer.concat([
    part(R4_NOTIFICATION_BOUNDARY, 'Content-Type: application/json', Buffer.from(JSON_NOTIFICATION)),
    Buffer.from(`--${R4_NOTIFICATION_BOUNDARY}--\r\n`),
  ])
}

/** Extreme: pure frames under one consistent boundary, no notifications. */
export function buildPureFrameBody(frame: Buffer = R4_FRAME): Buffer {
  return Buffer.concat([
    part(R4_FRAME_BOUNDARY, `Content-Type: image/jpeg\r\nContent-Length: ${String(frame.length)}`, frame),
    part(R4_FRAME_BOUNDARY, `Content-Type: image/jpeg\r\nContent-Length: ${String(frame.length)}`, frame),
    Buffer.from(`--${R4_FRAME_BOUNDARY}--\r\n`),
  ])
}
