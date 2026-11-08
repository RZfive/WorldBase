const fs = require("node:fs");
const path = require("node:path");

function copyIfMissing(source, target) {
  if (!fs.existsSync(source) || fs.existsSync(target)) {
    return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  return true;
}

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");

if (!fs.existsSync(standalone)) {
  console.warn(
    "[postbuild] .next/standalone is missing; make sure next.config.js sets output: 'standalone'.",
  );
  process.exit(0);
}

const copied = [];
if (
  copyIfMissing(
    path.join(root, ".next", "static"),
    path.join(standalone, ".next", "static"),
  )
) {
  copied.push(".next/static");
}
if (copyIfMissing(path.join(root, "public"), path.join(standalone, "public"))) {
  copied.push("public");
}

if (copied.length > 0) {
  console.log(`[postbuild] copied ${copied.join(", ")} into .next/standalone`);
} else {
  console.log("[postbuild] standalone assets already in place");
}
