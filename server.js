const express = require("express");
const AWS = require("aws-sdk");
const AtpAgent = require("@atproto/api").AtpAgent;
const multer = require("multer");
const fs = require("fs");
const RichText = require("@atproto/api").RichText;
const path = require("path");
const postgres = require("postgres");
const sharp = require("sharp");
const cors = require("cors");
const mastoCreate = require("masto").createRestAPIClient;
const slugify = require("slugify");
const ffmpeg = require("fluent-ffmpeg");
require("dotenv").config();

const agent = new AtpAgent({
  service: "https://bsky.social",
});

function makeSlugTitle(text) {
  return slugify(text, {
    lower: true, // Convert to lowercase
    strict: true, // Remove special characters
    replacement: "-", // Replace spaces with hyphens (default)
  });
}

function dateToSlugTimestamp(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day}-${hours}-${minutes}-${seconds}`;
}

function makeSlug(date, title) {
  let slug = dateToSlugTimestamp(date);
  if (title && title.length > 0) {
    const titleSlug = makeSlugTitle(title);
    slug += `-${titleSlug}`;
  }
  return slug;
}

function makeDBTimestamp(date) {
  // Should not need to do this with the offset
  const timezoneOffset = new Date().getTimezoneOffset() * 60 * 1000;
  const dbTimestamp = new Date(date.getTime() - timezoneOffset).toISOString();
  return dbTimestamp;
}

const sql = postgres(process.env.DATABASE_URL || "");

console.log("process.env.NODE_ENV", process.env.NODE_ENV);

const corsOptions = {
  origin: function (origin, callback) {
    if (
      process.env.NODE_ENV !== "production" ||
      origin === "https://feed.grantcuster.com" ||
      origin === "https://scrawl.grantcuster.com"
    ) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
};

// Authorization middleware function
function checkAuthorization(req, res, next) {
  const authHeader = req.headers.authorization;
  const expectedToken = `Bearer ${process.env.ADMIN_PASSWORD}`;

  if (authHeader !== expectedToken) {
    return res.status(403).send("Forbidden");
  }

  next(); // Proceed to the next middleware or route handler
}

const app = express();
app.use(cors(corsOptions));
app.use(checkAuthorization);
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb" }));

// Set up AWS S3
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

const formatDate = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(now.getDate()).padStart(2, "0")}-${String(
    now.getHours(),
  ).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(
    now.getSeconds(),
  ).padStart(2, "0")}`;
};

// Set up multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    const formattedDate = formatDate();
    cb(null, formattedDate + path.extname(file.originalname)); // Append the file extension
  },
});
const upload = multer({ storage: storage });

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

const smallSize = 800;
const largeSize = 2000;

const resizeImage = (inputPath, outputDir, callback) => {
  const fileName = path.basename(inputPath, path.extname(inputPath));

  // Define output paths
  const smallPath = path.join(outputDir, `${fileName}-${smallSize}.jpg`);
  const largePath = path.join(outputDir, `${fileName}-${largeSize}.jpg`);

  // Resize to small (800px)
  sharp(inputPath)
    .resize(smallSize, smallSize, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .toFile(smallPath, (err) => {
      if (err) {
        return callback(err);
      }

      // Resize to large (2000px)
      sharp(inputPath)
        .resize(largeSize, largeSize, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .toFile(largePath, (err) => {
          if (err) {
            return callback(err);
          }

          callback(null, {
            small: smallPath,
            large: largePath,
          });
        });
    });
};

const uploadToS3 = (filePath, key, contentType, callback) => {
  const fileContent = fs.readFileSync(filePath);

  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    Body: fileContent,
    ContentType: contentType,
  };

  s3.upload(params, (err, data) => {
    if (err) {
      return callback(err);
    }
    callback(null, data.Location);
  });
};

app.get("/", (req, res) => {
  res.send("Hello, this is the upload server!");
});

function uploadToS3Promise(filePath, key, contentType) {
  return new Promise((resolve, reject) => {
    uploadToS3(filePath, key, contentType, (err, location) => {
      if (err) return reject(err);
      resolve(location);
    });
  });
}

function addToUploadsTable(key, contentType) {
  const created_at = new Date();
  return sql`
    INSERT INTO uploads (s3_key, file_type, created_at)
    VALUES (${key}, ${contentType}, ${created_at})
    RETURNING id`;
}

app.post("/api/upload", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).send("No file uploaded.");
  }

  const mime = file.mimetype;
  const ext = path.extname(file.originalname).toLowerCase();
  const fileName = path.basename(file.path, ext);

  try {
    if (mime.startsWith("image/") && ext !== ".gif") {
      // Handle image (non-GIF)
      const outputDir = "uploads/";
      resizeImage(file.path, outputDir, async (err, resizedImages) => {
        if (err) {
          console.error("Error resizing image:", err);
          return res.status(500).send("Error resizing image.");
        }

        const { small, large } = resizedImages;

        try {
          const largeLocation = await uploadToS3Promise(
            large,
            `${fileName}-${largeSize}.jpg`,
            "image/jpeg",
          );

          const smallLocation = await uploadToS3Promise(
            small,
            `${fileName}-${smallSize}.jpg`,
            "image/jpeg",
          );

          fs.unlinkSync(file.path);
          fs.unlinkSync(small);
          fs.unlinkSync(large);

          await addToUploadsTable(
            `${fileName}-${largeSize}.jpg`,
            "image/jpeg",
          );
          await addToUploadsTable(
            `${fileName}-${smallSize}.jpg`,
            "image/jpeg",
          );

          return res.send({
            message: "Images uploaded successfully",
            smallImageUrl: smallLocation,
            largeImageUrl: largeLocation,
          });
        } catch (uploadErr) {
          console.error("Image upload error:", uploadErr);
          return res.status(500).send("Error uploading images.");
        }
      });
    } else if (ext === ".gif") {
      // Handle GIF
      const gifKey = `${fileName}.gif`;
      const jpgKey = `${fileName}-preview.jpg`;

      const firstFrameBuffer = await sharp(file.path, { pages: 1 })
        .jpeg()
        .toBuffer();
      const jpgPath = path.join(path.dirname(file.path), jpgKey);
      fs.writeFileSync(jpgPath, firstFrameBuffer);

      const gifLocation = await uploadToS3Promise(
        file.path,
        gifKey,
        "image/gif",
      );
      const jpgLocation = await uploadToS3Promise(
        jpgPath,
        jpgKey,
        "image/jpeg",
      );

      fs.unlinkSync(file.path);
      fs.unlinkSync(jpgPath);

      await addToUploadsTable(gifKey, "image/gif");

      return res.send({
        message: "GIF and preview uploaded successfully",
        gifUrl: gifLocation,
        jpgUrl: jpgLocation,
      });
    } else if (mime.startsWith("video/")) {
      // Handle video
      const key = `${fileName}.mp4`;
      const location = await uploadToS3Promise(file.path, key, "video/mp4");
      fs.unlinkSync(file.path);

      await addToUploadsTable(key, "video/mp4");

      return res.send({
        message: "Video uploaded successfully",
        videoUrl: location,
      });
    } else if (mime.startsWith("audio/")) {
      // Handle audio
      const key = `${fileName}.mp3`;
      const location = await uploadToS3Promise(file.path, key, "audio/mpeg");
      fs.unlinkSync(file.path);

      await addToUploadsTable(key, "audio/mpeg");

      return res.send({
        message: "Audio uploaded successfully",
        audioUrl: location,
      });
    } else {
      fs.unlinkSync(file.path);
      return res.status(400).send("Unsupported file type.");
    }
  } catch (err) {
    console.error("Unexpected error:", err);
    fs.unlinkSync(file.path);
    return res.status(500).send("Unexpected server error.");
  }
});

app.get("/api/list-objects", async (req, res) => {
  if (req.headers.authorization !== "Bearer " + process.env.ADMIN_PASSWORD) {
    return res.status(403).send("Forbidden");
  }

  const maxKeys = 20; // Limit to 20 objects
  const continuationToken = req.query.continuationToken || null; // Optional token for pagination

  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    MaxKeys: maxKeys,
    ContinuationToken: continuationToken,
  };

  try {
    const data = await s3.listObjectsV2(params).promise();
    const sortedData = data.Contents.sort(
      (a, b) => new Date(b.LastModified) - new Date(a.LastModified),
    );

    res.json({
      Contents: sortedData,
      NextContinuationToken: data.NextContinuationToken, // Include next token for pagination
    });
  } catch (err) {
    console.error("Error listing objects:", err);
    res.status(500).send("Error listing objects.");
  }
});

app.post("/api/postToFeed", async (req, res) => {
  if (req.headers.authorization !== "Bearer " + process.env.ADMIN_PASSWORD) {
    return res.status(403).send("Forbidden");
  }

  const { title, content, created_at = new Date(), tags } = req.body;
  const slug = req.body.slug || makeSlug(created_at, title);

  const dbTimestamp = makeDBTimestamp(created_at);

  const idData = await sql`
      INSERT INTO posts (title, content, slug, created_at, updated_at)
      VALUES (${title || null}, ${content}, ${slug}, ${dbTimestamp}, ${dbTimestamp})
      RETURNING id`;

  const id = idData[0].id;

  // Extract current tag names
  const currentTagNames = tags;

  for (const tag of currentTagNames) {
    let tagId;

    // Ensure the tag exists in the 'tags' table
    const tagRecord = await sql`
        INSERT INTO tags (name)
        VALUES (${tag})
        ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id`;

    tagId = tagRecord[0].id;

    // Ensure the association exists in 'post_tags'
    await sql`
        INSERT INTO post_tags (post_id, tag_id)
        VALUES (${id}, ${tagId})
        ON CONFLICT (post_id, tag_id) DO NOTHING`;
  }

  res.json({ success: "posted" });
});

app.post("/api/postToMastodon", async (req, res) => {
  const status = req.body.status;
  const post = {
    status,
    visibility: "public",
  };

  if (req.headers.authorization !== "Bearer " + process.env.ADMIN_PASSWORD) {
    return res.status(403).send("Forbidden");
  }

  try {
    const client = mastoCreate({
      url: "https://mastodon.social",
      accessToken: process.env.MASTODON_ACCESS_TOKEN,
    });

    await client.v1.statuses.create(post);

    res.json({ success: "posted" });
  } catch (error) {
    console.log(error);
    res.status(500).send("Error posting to mastodon.");
  }
});

app.post("/api/postImageOrGifToMastodon", async (req, res) => {
  const status = req.body.status;
  const imageUrl = req.body.imageUrl;

  if (req.headers.authorization !== "Bearer " + process.env.ADMIN_PASSWORD) {
    return res.status(403).send("Forbidden");
  }

  try {
    const client = mastoCreate({
      url: "https://mastodon.social",
      accessToken: process.env.MASTODON_ACCESS_TOKEN,
    });

    const remoteFile = await fetch(imageUrl);
    const media = await client.v2.media.create({
      file: await remoteFile.blob(),
      description: "",
    });

    const post = {
      status,
      visibility: "public",
      mediaIds: [media.id],
    };

    await client.v1.statuses.create(post);

    res.json({ success: "posted" });
  } catch (error) {
    console.log(error);
    res.status(500).send("Error posting to mastodon.");
  }
});

app.post("/api/postImageToBluesky", async (req, res) => {
  const status = req.body.status;
  const imageUrl = req.body.imageUrl;
  const width = req.body.width;
  const height = req.body.height;

  // Fetch the remote image
  const response = await fetch(imageUrl);
  const arrayBuffer = await response.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);

  // Retrieve the content type (MIME type)
  const contentType = response.headers.get("content-type");

  await agent.login({
    identifier: process.env.BLUESKY_IDENTIFIER,
    password: process.env.BLUESKY_PASSWORD,
  });

  // Upload the blob with the retrieved content type
  const { data } = await agent.uploadBlob(uint8Array, {
    encoding: contentType, // Use the MIME type from the response
  });

  try {
    const rt = new RichText({
      text: status,
    });
    await rt.detectFacets(agent);

    const _post = {
      text: rt.text,
      facets: rt.facets,
      createdAt: new Date().toISOString(),
      embed: {
        $type: "app.bsky.embed.images",
        images: [
          {
            alt: "Description of your image", // Add an appropriate alt text
            image: data.blob,
            aspectRatio: {
              width: width, // Use width from request body
              height: height, // Use height from request body
            },
          },
        ],
      },
    };

    await agent.post(_post);

    res.json({ success: "posted" });
  } catch (error) {
    console.log(error);
    res.status(500).send("Error uploading file to agent.");
  }
});

app.post("/api/postToBluesky", async (req, res) => {
  const status = req.body.status;
  const url = req.body.url;
  const image = req.body.image;
  const title = req.body.title;
  const description = req.body.description;

  if (req.headers.authorization !== "Bearer " + process.env.ADMIN_PASSWORD) {
    return res.status(403).send("Forbidden");
  }

  try {
    const rt = new RichText({
      text: status,
    });
    await rt.detectFacets(agent);

    const _post = {
      text: rt.text,
      facets: rt.facets,
      createdAt: new Date().toISOString(),
      embed: {
        $type: "app.bsky.embed.external",
        external: {
          uri: url,
          title: title,
          description: description,
          thumb: image,
        },
      },
    };

    await agent.login({
      identifier: process.env.BLUESKY_IDENTIFIER,
      password: process.env.BLUESKY_PASSWORD,
    });
    const data = await uploadS3FileToAgent(
      agent,
      _post.embed.external.thumb
        .replace("https://grant-uploader.s3.amazonaws.com/", "")
        .replace("https://grant-uploader.s3.us-east-2.amazonaws.com/", ""),
    );

    _post.embed.external.thumb = data.blob;

    await agent.post(_post);

    res.json({ success: "posted" });
  } catch (error) {
    console.log(error);
    res.status(500).send("Error uploading file to agent.");
  }
});

app.post("/api/postGifToBluesky", async (req, res) => {
  console.log("posting gif to bluesky");
  const status = req.body.status;
  const imageUrl = req.body.imageUrl;

  // Step 1: Download the GIF
  const response = await fetch(imageUrl);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const inputFilePath = "./input.gif";
  fs.writeFileSync(inputFilePath, buffer);

  // Step 2: Process the GIF with ffmpeg
  const outputFilePath = "./output.mp4";
  await new Promise((resolve, reject) => {
    ffmpeg(inputFilePath)
      .outputOptions("-movflags", "faststart", "-pix_fmt", "yuv420p")
      .videoFilters("scale=trunc(iw/2)*2:trunc(ih/2)*2")
      .on("end", resolve)
      .on("error", reject)
      .save(outputFilePath);
  });

  const video = fs.readFileSync(outputFilePath);

  // video upload based on https://gist.github.com/mozzius/5cbbd15e12cdc0cb1d0d992b7c3b1d0f?permalink_comment_id=5506517#gistcomment-5506517

  await agent.login({
    identifier: process.env.BLUESKY_IDENTIFIER,
    password: process.env.BLUESKY_PASSWORD,
  });

  // Upload the blob with the retrieved content type
  const uploadUrl = new URL(
    "https://video.bsky.app/xrpc/app.bsky.video.uploadVideo",
  );
  uploadUrl.searchParams.append("did", agent.session.did);
  uploadUrl.searchParams.append("name", imageUrl.split("/").pop());

  const { data: serviceAuth } = await agent.com.atproto.server.getServiceAuth({
    aud: `did:web:${agent.dispatchUrl.host}`,
    lxm: "com.atproto.repo.uploadBlob",
    exp: Date.now() / 1000 + 60 * 30, // 30 minutes
  });

  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceAuth.token}`,
      "Content-Type": "video/mp4",
      "Content-Length": video.byteLength.toString(),
    },
    body: video,
  });

  const jobStatus = await uploadResponse.json();
  console.log("JobId:", jobStatus.jobId);
  let blob = jobStatus.blob;
  const videoAgent = new AtpAgent({ service: "https://video.bsky.app" });

  while (!blob) {
    const { data: status } = await videoAgent.app.bsky.video.getJobStatus({
      jobId: jobStatus.jobId,
    });
    console.log(
      "Status:",
      status.jobStatus.state,
      status.jobStatus.progress || "",
    );
    if (status.jobStatus.blob) {
      blob = status.jobStatus.blob;
    }
    // wait a second
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log("video uploaded");
  console.log("posting...");

  const rt = new RichText({
    text: status,
  });
  await rt.detectFacets(agent);

  const _post = {
    text: rt.text,
    facets: rt.facets,
    createdAt: new Date().toISOString(),
    embed: {
      $type: "app.bsky.embed.video",
      video: blob,
    },
  };
  await agent.post(_post);

  console.log("posted");

  // Cleanup temporary files
  fs.unlinkSync(inputFilePath);
  fs.unlinkSync(outputFilePath);

  res.json({ success: "posted" });
});

async function uploadS3FileToAgent(agent, s3Key) {
  try {
    // Download file from S3
    const s3Object = await s3
      .getObject({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: s3Key,
      })
      .promise();

    // `s3Object.Body` is already a Buffer, so you can use it directly
    const fileBuffer = s3Object.Body;

    // Upload the buffer to your agent (assuming the agent accepts Buffer for blob data)
    const { data } = await agent.uploadBlob(fileBuffer, {
      encoding: "image/jpeg",
    });

    return data; // Response from agent upload
  } catch (error) {
    console.log(error);
    console.error("Error uploading file:", error);
    throw error;
  }
}

const port = 3030;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
