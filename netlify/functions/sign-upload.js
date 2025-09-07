// netlify/functions/sign-upload.js
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

export async function handler(event) {
  try {
    const { name, type, run_id } = JSON.parse(event.body || "{}");
    if (!name || !type || !run_id) {
      return { statusCode: 400, body: "missing name/type/run_id" };
    }
    const key = `uploads/${run_id}/${Date.now()}-${name}`;
    const cmd = new PutObjectCommand({
      Bucket: process.env.S3_B

