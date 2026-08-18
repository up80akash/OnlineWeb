// Reusable secure file upload utility, shared by the deposit-screenshot and
// support-attachment features (and anything else that needs "let a user
// upload an image" in the future). Nothing here trusts the client: not the
// original filename, not the declared MIME type, not the file extension --
// every file is re-validated against its actual bytes before it's written
// to disk, under a name we generate ourselves.
//
//   validateImage(buffer, declaredMime) -> { ext, mime }   (throws GameError)
//   generateSecureFilename(ext) -> "<random-uuid>.<ext>"
//   storeFile(buffer, subdir, filename) -> relative path, e.g. "deposits/<uuid>.jpg"
//   deleteFile(relPath)
//   resolveUploadPath(relPath) -> absolute path, guaranteed inside UPLOAD_ROOT
//   streamUpload(res, relPath, mime) -> sends the file or 404s
//   imageUploadMiddleware(fieldName) -> multer middleware (memory storage,
//     size-limited, MIME-filtered) for use before validateImage/storeFile

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const { GameError } = require("./errors");

const UPLOAD_ROOT = path.join(__dirname, "..", "uploads");
const MAX_BYTES = 5 * 1024 * 1024; // 5MB

// mime -> canonical extension. Deliberately small and explicit -- anything
// not in this list (svg, gif, pdf, and definitely anything executable) is
// rejected outright, regardless of what the client claims.
const ALLOWED_MIME_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

for (const sub of ["deposits", "support"]) {
  fs.mkdirSync(path.join(UPLOAD_ROOT, sub), { recursive: true });
}

// Magic-byte signatures for the formats we accept. The client-declared MIME
// type/extension is only used as a fast-path filter in multer's fileFilter;
// the byte signature below is what actually decides whether a file is
// stored, so a renamed .exe with a spoofed "image/png" Content-Type still
// gets rejected here.
function sniffImageExt(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return "png";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

function validateImage(buffer, declaredMime) {
  if (!buffer || !buffer.length) {
    throw new GameError("Uploaded file is empty.", 400);
  }
  if (buffer.length > MAX_BYTES) {
    throw new GameError(`Image exceeds the maximum allowed size of ${MAX_BYTES / (1024 * 1024)}MB.`, 400);
  }
  const sniffedExt = sniffImageExt(buffer);
  if (!sniffedExt) {
    throw new GameError("Invalid image format. Upload a JPG, PNG or WebP image.", 400);
  }
  // Cross-check: the bytes must actually match a format whose MIME the
  // client claimed to be sending (belt-and-suspenders -- sniffedExt alone
  // already fully determines what we store it as).
  if (declaredMime && ALLOWED_MIME_EXT[declaredMime] && ALLOWED_MIME_EXT[declaredMime] !== sniffedExt) {
    throw new GameError("Invalid image format. Upload a JPG, PNG or WebP image.", 400);
  }
  const mime = Object.keys(ALLOWED_MIME_EXT).find((m) => ALLOWED_MIME_EXT[m] === sniffedExt);
  return { ext: sniffedExt, mime };
}

function generateSecureFilename(ext) {
  return `${crypto.randomUUID()}.${ext}`;
}

function storeFile(buffer, subdir, filename) {
  const absDir = path.join(UPLOAD_ROOT, subdir);
  const absPath = path.join(absDir, filename);
  fs.writeFileSync(absPath, buffer, { mode: 0o600 });
  return `${subdir}/${filename}`;
}

function deleteFile(relPath) {
  if (!relPath) return;
  try {
    fs.unlinkSync(resolveUploadPath(relPath));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

// Defense in depth: relPath always comes from a value *we* generated and
// stored in the database (never directly from a client-supplied path), but
// this guard makes path traversal structurally impossible even if that
// ever changed.
function resolveUploadPath(relPath) {
  const abs = path.resolve(UPLOAD_ROOT, relPath);
  if (abs !== UPLOAD_ROOT && !abs.startsWith(UPLOAD_ROOT + path.sep)) {
    throw new GameError("Invalid file reference.", 400);
  }
  return abs;
}

function streamUpload(res, relPath, mime) {
  let abs;
  try {
    abs = resolveUploadPath(relPath);
  } catch {
    return res.status(404).json({ error: "File not found." });
  }
  if (!fs.existsSync(abs)) {
    return res.status(404).json({ error: "File not found." });
  }
  res.setHeader("Content-Type", mime || "application/octet-stream");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  fs.createReadStream(abs).pipe(res);
}

// multer only buffers the upload in memory and applies a fast, cheap
// pre-filter (size + declared MIME); the authoritative check is
// validateImage() against the real bytes, called by the route handler
// after this middleware runs.
function imageUploadMiddleware(fieldName) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
      if (!ALLOWED_MIME_EXT[file.mimetype]) {
        cb(new GameError("Invalid image format. Upload a JPG, PNG or WebP image.", 400));
        return;
      }
      cb(null, true);
    },
  }).single(fieldName);

  // Wrap so multer's own errors (e.g. LIMIT_FILE_SIZE) come back as the
  // same { error: "..." } shape as the rest of the API instead of a raw
  // multer error object.
  return (req, res, next) => {
    upload(req, res, (err) => {
      if (!err) return next();
      if (err instanceof GameError) return res.status(err.status).json({ error: err.message });
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: `Image exceeds the maximum allowed size of ${MAX_BYTES / (1024 * 1024)}MB.` });
      }
      return res.status(400).json({ error: "Could not process the uploaded file." });
    });
  };
}

module.exports = {
  MAX_BYTES,
  validateImage,
  generateSecureFilename,
  storeFile,
  deleteFile,
  resolveUploadPath,
  streamUpload,
  imageUploadMiddleware,
};
