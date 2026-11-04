package app.valence.core

import java.io.File

/** Goldens were produced by running the desktop's own TypeScript (see golden/README in the report). */
internal object Golden {
    fun load(name: String): Map<*, *> {
        val text = Golden::class.java.getResource("/golden/$name")!!.readText(Charsets.UTF_8)
        return JsJson.parse(text) as Map<*, *>
    }

    fun resourceDir(path: String): File = File(Golden::class.java.getResource(path)!!.toURI())
}

internal fun Map<*, *>.list(key: String): List<Map<*, *>> = (this[key] as List<*>).map { it as Map<*, *> }

internal fun Map<*, *>.str(key: String): String? = this[key].let { if (it == JsonNull || it == null) null else it as String }

internal fun Map<*, *>.num(key: String): Double? = this[key].let { if (it == JsonNull || it == null) null else (it as Double) }

internal fun Map<*, *>.bool(key: String): Boolean = this[key] as Boolean

/** Printable form of a string for assertion messages. */
internal fun esc(s: String?): String = if (s == null) "null" else JsJson.quote(s).toString()
