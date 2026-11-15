const ALLOWED_MODELS = new Set([
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
    "gemini-2.5-flash",
    "gemini-3.8-flash"
]);

module.exports = async function handler(req, res) {
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ error: { message: "Method not allowed. Use POST." } });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({
            error: { message: "Server GEMINI_API_KEY is not configured in Vercel Environment Variables." }
        });
    }

    let body = req.body;
    if (typeof body === "string") {
        try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    try {
        // 1) Initialize Gemini resumable upload for larger video clips (> 3 MB)
        if (body.action === "init_upload") {
            const initRes = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
                method: "POST",
                headers: {
                    "x-goog-api-key": apiKey,
                    "X-Goog-Upload-Protocol": "resumable",
                    "X-Goog-Upload-Command": "start",
                    "X-Goog-Upload-Header-Content-Length": String(body.fileSize || 0),
                    "X-Goog-Upload-Header-Content-Type": String(body.mimeType || "video/mp4"),
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ file: { display_name: String(body.fileName || "hook-clip") } })
            });

            const uploadUrl = initRes.headers.get("X-Goog-Upload-URL");
            if (!initRes.ok || !uploadUrl) {
                const errData = await initRes.json().catch(() => ({}));
                return res.status(initRes.status || 500).json(errData);
            }
            return res.status(200).json({ uploadUrl });
        }

        // 2) Poll uploaded video file status until ACTIVE
        if (body.action === "poll_file") {
            const name = String(body.name || "");
            if (!/^files\/[a-zA-Z0-9_-]+$/.test(name)) {
                return res.status(400).json({ error: { message: "Invalid file resource name." } });
            }
            const checkRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}`, {
                headers: { "x-goog-api-key": apiKey }
            });
            const data = await checkRes.json().catch(() => ({}));
            return res.status(checkRes.status).json(data);
        }

        // 3) Clean up temporary uploaded video
        if (body.action === "delete_file") {
            const name = String(body.name || "");
            if (!/^files\/[a-zA-Z0-9_-]+$/.test(name)) {
                return res.status(400).json({ error: { message: "Invalid file resource name." } });
            }
            await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}`, {
                method: "DELETE",
                headers: { "x-goog-api-key": apiKey }
            });
            return res.status(200).json({ deleted: true });
        }

        // 4) Proxy generateContent to Gemini
        const model = ALLOWED_MODELS.has(body.model) ? body.model : "gemini-3.5-flash-lite";
        const upstreamUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

        const upstreamRes = await fetch(upstreamUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": apiKey
            },
            body: JSON.stringify(body.payload || {})
        });

        const data = await upstreamRes.json().catch(() => ({}));
        return res.status(upstreamRes.status).json(data);
    } catch (err) {
        return res.status(502).json({
            error: { message: err?.message || "Failed to contact Gemini API from server proxy." }
        });
    }
};