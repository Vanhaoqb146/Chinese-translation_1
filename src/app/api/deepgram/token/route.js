export async function GET() {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    return Response.json({ error: 'DEEPGRAM_API_KEY not configured' }, { status: 500 });
  }
  // Trả key cho browser dùng qua WebSocket subprotocol: new WebSocket(url, ['token', key])
  return Response.json({ key });
}
