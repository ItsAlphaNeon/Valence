package app.valence.playback

import android.util.AtomicFile
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Musicolet-style multiple queues. Each queue remembers its own songs, current song and position,
 * so switching queues picks up where that queue left off. Persisted as rel paths (stable across
 * index rebuilds) in the app's private files.
 */
data class SavedQueue(
    val id: Long,
    val name: String,
    val paths: List<String>,
    val index: Int,
    val positionMs: Long,
    val updatedAt: Long = System.currentTimeMillis(),
)

class QueueStore(dir: File) {
    private val file = AtomicFile(File(dir, "queues.json"))

    data class Snapshot(val queues: List<SavedQueue>, val activeId: Long)

    fun load(): Snapshot = runCatching {
        if (!file.baseFile.exists()) return Snapshot(emptyList(), -1)
        val o = JSONObject(file.readFully().decodeToString())
        val arr = o.optJSONArray("queues") ?: JSONArray()
        val queues = (0 until arr.length()).map { i ->
            val q = arr.getJSONObject(i)
            val p = q.getJSONArray("paths")
            SavedQueue(
                id = q.getLong("id"),
                name = q.optString("name"),
                paths = (0 until p.length()).map { p.getString(it) },
                index = q.optInt("index"),
                positionMs = q.optLong("pos"),
                updatedAt = q.optLong("updatedAt"),
            )
        }
        Snapshot(queues, o.optLong("active", -1))
    }.getOrElse {
        Log.w("ValenceQueues", "Couldn't read queues: ${it.message}")
        Snapshot(emptyList(), -1)
    }

    fun save(s: Snapshot) {
        val o = JSONObject()
        o.put("active", s.activeId)
        o.put("queues", JSONArray().apply {
            for (q in s.queues) put(JSONObject().apply {
                put("id", q.id)
                put("name", q.name)
                put("paths", JSONArray(q.paths))
                put("index", q.index)
                put("pos", q.positionMs)
                put("updatedAt", q.updatedAt)
            })
        })
        val out = file.startWrite()
        try {
            out.write(o.toString().encodeToByteArray())
            file.finishWrite(out)
        } catch (e: Exception) {
            file.failWrite(out)
            Log.w("ValenceQueues", "Couldn't save queues: ${e.message}")
        }
    }
}
