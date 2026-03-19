export async function GET() {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;

  if (!key || !region) {
    return Response.json(
      { error: 'AZURE_SPEECH_KEY or AZURE_SPEECH_REGION not configured' },
      { status: 500 }
    );
  }

  try {
    // Exchange subscription key for a short-lived token (10 min)
    const tokenRes = await fetch(
      `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Content-Length': '0',
        },
      }
    );

    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${tokenRes.status}`);
    }

    const token = await tokenRes.text();
    return Response.json({ token, region });
  } catch (err) {
    console.error('Azure token error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
