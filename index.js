const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const unzipper = require("unzipper");

const REGION = process.env.AWS_REGION || "us-east-2";
const BUCKET = process.env.DGMMV_BUCKET;

const s3 = new S3Client({ region: REGION });

async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", chunk => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

async function mxlToMusicXml(mxlBuffer) {
  const directory = await unzipper.Open.buffer(mxlBuffer);
  const entry =
    directory.files.find(f => /\.musicxml$/i.test(f.path)) ||
    directory.files.find(f => /\.xml$/i.test(f.path));
  if (!entry) throw new Error("MXL file contains no MusicXML.");
  return await entry.buffer();
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildHtml({ title, transpose, xmlBase64 }) {
  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${escapeHtml(title)}</title>
  <style>
    body {
      margin: 0;
      padding: 12mm;
      background: #ffffff;
      font-family: Arial, sans-serif;
    }
    #osmd {
      width: 100%;
    }
  </style>
</head>
<body>
  <div id="osmd"></div>

  <script src="https://cdn.jsdelivr.net/npm/opensheetmusicdisplay@1.8.8/build/opensheetmusicdisplay.min.js"></script>
  <script>
    (async function () {
      const xml = atob("${xmlBase64}");
      const transpose = ${Number(transpose) || 0};

      const osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay("osmd", {
        backend: "svg",
        autoResize: false,
        drawTitle: true
      });

      await osmd.load(xml);
      osmd.Zoom = 1.0;
      osmd.render();

      try {
        osmd.Sheet.Transpose = transpose;
        try {
          osmd.TransposeCalculator = new opensheetmusicdisplay.TransposeCalculator();
        } catch(e){}
        if (typeof osmd.updateGraphic === "function") {
          osmd.updateGraphic();
        }
        osmd.render();
      } catch(e) {}

      window.__DGMMV_READY__ = true;
    })();
  </script>
</body>
</html>
`;
}

exports.handler = async (event) => {
  try {
    if (!BUCKET) {
      return { statusCode: 500, body: "Missing DGMMV_BUCKET environment variable." };
    }

    const key = event.queryStringParameters?.key;
    const transpose = parseInt(event.queryStringParameters?.transpose || "0", 10) || 0;

    if (!key) {
      return { statusCode: 400, body: "Missing required query parameter: key" };
    }

    // Fetch file from S3
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key })
    );

    const fileBuffer = await streamToBuffer(obj.Body);

    let xmlBuffer = fileBuffer;
    if (/\.mxl$/i.test(key)) {
      xmlBuffer = await mxlToMusicXml(fileBuffer);
    }

    const xmlBase64 = xmlBuffer.toString("base64");
    const title = key.split("/").pop() || "DGMMV Sheet Music";

    // Launch headless Chromium
    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      defaultViewport: { width: 1200, height: 1600 }
    });

    try {
      const page = await browser.newPage();

      const html = buildHtml({
        title,
        transpose,
        xmlBase64
      });

      await page.setContent(html, { waitUntil: "networkidle0" });
      await page.waitForFunction("window.__DGMMV_READY__ === true", { timeout: 30000 });

      const pdf = await page.pdf({
        format: "letter",
        printBackground: true,
        margin: {
          top: "12mm",
          right: "12mm",
          bottom: "12mm",
          left: "12mm"
        }
      });

      return {
        statusCode: 200,
        isBase64Encoded: true,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${title.replace(/[^\w.-]+/g, "_")}.pdf"`,
          "Access-Control-Allow-Origin": "*"
        },
        body: pdf.toString("base64")
      };
    } finally {
      await browser.close();
    }

  } catch (err) {
    return {
      statusCode: 500,
      body: "PDF render failed: " + (err && err.message ? err.message : String(err))
    };
  }
};
