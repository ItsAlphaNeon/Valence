package app.valence.core

import org.json.JSONArray
import org.json.JSONObject

/**
 * What the phone and the TV page say to each other, beyond what the Cast media channel carries:
 * the lyrics toggle and the lyrics themselves. The TV page can't fetch them from the
 * phone (an https page can't read plain-http data), so they travel over this channel.
 */
object CastMessages {
    const val NAMESPACE = "urn:x-cast:app.valence"

    /** Cast messages are capped near 64 KB. 16,000 chars stays under it even at 3 UTF-8 bytes each. */
    const val CHUNK_CHARS = 16_000

    /** Lyrics past this many messages (about 1 MB) aren't sent: nothing real is that long. */
    const val MAX_PARTS = 64

    /** Sent by the page when it starts (or restarts): the phone answers with everything it should know. */
    fun isHello(message: String): Boolean = runCatching { JSONObject(message).optString("t") == "hello" }.getOrDefault(false)

    fun settings(showLyrics: Boolean): String = JSONObject()
        .put("t", "settings")
        .put("lyrics", showLyrics)
        .toString()

    /** The lyrics of a track as the messages to send, in order. No lyrics is still one message, so the page knows. */
    fun lyrics(trackId: Long, text: String?): List<String> {
        val parts = chunks(lyricsJson(text))
        if (parts.size > MAX_PARTS) return lyrics(trackId, null)
        return parts.mapIndexed { i, part ->
            JSONObject()
                .put("t", "lyrics")
                .put("track", trackId)
                .put("part", i)
                .put("parts", parts.size)
                .put("data", part)
                .toString()
        }
    }

    /** `{"lines":[{"t":ms,"x":"words"}...]}` for synced lyrics, `{"text":"..."}` for plain, `{}` for none. */
    internal fun lyricsJson(text: String?): String {
        val body = text?.trim().orEmpty()
        if (body.isEmpty()) return "{}"
        val synced = parseLrc(body) ?: return JSONObject().put("text", body).toString()
        val lines = JSONArray()
        synced.forEach { lines.put(JSONObject().put("t", it.timeMs).put("x", it.text)) }
        return JSONObject().put("lines", lines).toString()
    }

    /** Splits [s] into pieces of at most [max] chars, never between the two halves of an emoji. */
    internal fun chunks(s: String, max: Int = CHUNK_CHARS): List<String> {
        if (s.length <= max) return listOf(s)
        val out = ArrayList<String>()
        var from = 0
        while (from < s.length) {
            var to = minOf(from + max, s.length)
            if (to < s.length && s[to - 1].isHighSurrogate()) to--
            out.add(s.substring(from, to))
            from = to
        }
        return out
    }
}
