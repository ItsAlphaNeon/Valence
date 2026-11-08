package app.valence.core

import java.io.BufferedOutputStream
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.io.RandomAccessFile
import java.net.Inet6Address
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** What the TV can be sent: a file or some bytes, with their MIME type. */
sealed interface CastContent {
    val mime: String
    class OfFile(val file: File, override val mime: String) : CastContent
    class OfBytes(val bytes: ByteArray, override val mime: String) : CastContent
}

/**
 * The little web server a TV plays this phone's music from, running only while casting. A TV
 * can't read the phone's files, so each song and cover gets a URL on the local network.
 *
 * Nothing from the network reaches the file system: a request names a track id, which the two
 * lookups turn into content. Every URL starts with a random token, so other devices on the Wi-Fi
 * can't list or fetch the library. Read-only: GET and HEAD, with the Range requests media players use.
 */
class CastServer(
    private val address: InetAddress,
    private val audio: (Long) -> CastContent?,
    private val art: (Long) -> CastContent?,
    val token: String = newToken(),
) {
    private val clients = ConcurrentHashMap.newKeySet<Socket>()
    private val pool = ThreadPoolExecutor(0, MAX_CLIENTS, 30, TimeUnit.SECONDS, SynchronousQueue()) { r ->
        Thread(r, "CastServer").apply { isDaemon = true }
    }

    @Volatile private var server: ServerSocket? = null

    val port: Int get() = server?.localPort ?: -1

    private val host: String
        get() = (address.hostAddress ?: "").let { if (address is Inet6Address) "[${it.substringBefore('%')}]" else it }

    /** [ext] only helps a player guess the format; the id is what's looked up. */
    fun audioUrl(trackId: Long, ext: String): String = "http://$host:$port/$token/audio/$trackId${if (ext.isEmpty()) "" else ".$ext"}"
    fun artUrl(trackId: Long): String = "http://$host:$port/$token/art/$trackId"

    fun start() {
        if (server != null) return
        val socket = ServerSocket(0, 32, address)
        server = socket
        thread(name = "CastServer-accept", isDaemon = true) { acceptLoop(socket) }
    }

    fun stop() {
        runCatching { server?.close() }
        server = null
        clients.forEach { runCatching { it.close() } }
        clients.clear()
        pool.shutdownNow()
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (!socket.isClosed) {
            val client = try {
                socket.accept()
            } catch (_: SocketException) {
                return
            } catch (_: IOException) {
                continue
            }
            clients.add(client)
            try {
                pool.execute {
                    try {
                        serve(client)
                    } catch (_: IOException) {
                        // The TV went away or changed its mind (it often does, between ranges).
                    } finally {
                        clients.remove(client)
                        runCatching { client.close() }
                    }
                }
            } catch (_: RejectedExecutionException) {
                clients.remove(client)
                runCatching { client.getOutputStream().write(bytes(head(503, "Service Unavailable", listOf("Content-Length: 0")))) }
                runCatching { client.close() }
            }
        }
    }

    private fun serve(client: Socket) {
        client.soTimeout = READ_TIMEOUT_MS
        client.tcpNoDelay = true
        val request = readRequest(client.getInputStream())
        val out = BufferedOutputStream(client.getOutputStream(), BUFFER_SIZE)
        if (request == null) return empty(out, 400, "Bad Request")
        when (request.method) {
            "GET", "HEAD" -> Unit
            "OPTIONS" -> return empty(out, 204, "No Content")
            else -> return empty(out, 405, "Method Not Allowed", listOf("Allow: GET, HEAD, OPTIONS"))
        }
        val content = lookup(request.target) ?: return empty(out, 404, "Not Found")
        send(out, request, content)
    }

    private fun lookup(target: String): CastContent? {
        val parts = target.substringBefore('?').split('/')
        // "/token/kind/name" splits into ["", token, kind, name].
        if (parts.size != 4 || parts[0].isNotEmpty()) return null
        if (!MessageDigest.isEqual(parts[1].toByteArray(), token.toByteArray())) return null
        val id = parts[3].substringBefore('.').toLongOrNull() ?: return null
        return runCatching {
            when (parts[2]) {
                "audio" -> audio(id)
                "art" -> art(id)
                else -> null
            }
        }.getOrNull()
    }

    private fun send(out: OutputStream, request: Request, content: CastContent) {
        val length = when (content) {
            is CastContent.OfFile -> if (content.file.isFile) content.file.length() else return empty(out, 404, "Not Found")
            is CastContent.OfBytes -> content.bytes.size.toLong()
        }
        val range = request.range?.let { parseRange(it, length) }
        if (range == UNSATISFIABLE) return empty(out, 416, "Range Not Satisfiable", listOf("Content-Range: bytes */$length"))
        val from = range?.first ?: 0L
        val to = range?.last ?: (length - 1)
        val count = to - from + 1
        val headers = buildList {
            add("Content-Type: ${content.mime}")
            add("Content-Length: $count")
            add("Accept-Ranges: bytes")
            if (range != null) add("Content-Range: bytes $from-$to/$length")
        }
        out.write(bytes(if (range != null) head(206, "Partial Content", headers) else head(200, "OK", headers)))
        if (request.method == "GET" && count > 0) body(out, content, from, count)
        out.flush()
    }

    private fun body(out: OutputStream, content: CastContent, from: Long, count: Long) {
        when (content) {
            is CastContent.OfBytes -> ByteArrayInputStream(content.bytes, from.toInt(), count.toInt()).use { it.copyTo(out, BUFFER_SIZE) }
            is CastContent.OfFile -> RandomAccessFile(content.file, "r").use { file ->
                val buffer = ByteArray(BUFFER_SIZE)
                file.seek(from)
                var left = count
                while (left > 0) {
                    val n = file.read(buffer, 0, minOf(left, buffer.size.toLong()).toInt())
                    if (n < 0) break
                    out.write(buffer, 0, n)
                    left -= n
                }
            }
        }
    }

    private fun empty(out: OutputStream, code: Int, reason: String, extra: List<String> = emptyList()) {
        out.write(bytes(head(code, reason, extra + "Content-Length: 0")))
        out.flush()
    }

    private fun bytes(s: String) = s.toByteArray(StandardCharsets.ISO_8859_1)

    private fun head(code: Int, reason: String, headers: List<String>): String = buildString {
        append("HTTP/1.1 $code $reason\r\n")
        headers.forEach { append(it).append("\r\n") }
        // The receiver page is on https://; these let it read from a phone on the local network.
        append("Access-Control-Allow-Origin: *\r\n")
        append("Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n")
        append("Access-Control-Allow-Headers: Range\r\n")
        append("Access-Control-Allow-Private-Network: true\r\n")
        append("Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\n")
        append("Cache-Control: no-store\r\n")
        append("Connection: close\r\n\r\n")
    }

    private class Request(val method: String, val target: String, val range: String?)

    private fun readRequest(input: InputStream): Request? {
        val lines = readHeadLines(input) ?: return null
        val first = lines.firstOrNull()?.split(' ') ?: return null
        if (first.size != 3 || !first[2].startsWith("HTTP/")) return null
        val range = lines.drop(1).firstOrNull { it.startsWith("range:", ignoreCase = true) }?.substringAfter(':')?.trim()
        return Request(first[0], first[1], range)
    }

    /** The request line and headers, or null if they're over [MAX_HEAD] or the client went away. */
    private fun readHeadLines(input: InputStream): List<String>? {
        val head = StringBuilder()
        while (head.length < MAX_HEAD) {
            val b = input.read()
            if (b < 0) return null
            head.append(b.toChar())
            if (head.endsWith("\r\n\r\n")) return head.removeSuffix("\r\n\r\n").split("\r\n")
        }
        return null
    }

    companion object {
        private const val MAX_CLIENTS = 16
        private const val BUFFER_SIZE = 64 * 1024
        private const val MAX_HEAD = 16 * 1024
        private const val READ_TIMEOUT_MS = 20_000

        internal val UNSATISFIABLE = -1L..-1L

        fun newToken(): String {
            val b = ByteArray(16).also { SecureRandom().nextBytes(it) }
            return b.joinToString("") { "%02x".format(it) }
        }

        /** The type a file is sent as; players go by this, not by the URL. */
        fun audioMime(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
            "mp3" -> "audio/mpeg"
            "opus", "ogg", "oga" -> "audio/ogg"
            "flac" -> "audio/flac"
            "m4a", "mp4", "m4b" -> "audio/mp4"
            "aac" -> "audio/aac"
            "wav" -> "audio/wav"
            "webm", "weba" -> "audio/webm"
            else -> "application/octet-stream"
        }

        /**
         * The range in a Range header, in bytes of a [length]-byte file: null means send it all (what
         * the spec says to do with one we can't use, such as several ranges or another unit), and
         * [UNSATISFIABLE] a range past the end.
         */
        internal fun parseRange(header: String, length: Long): LongRange? {
            val spec = header.trim()
            if (!spec.startsWith("bytes=", ignoreCase = true)) return null
            val value = spec.substring(6).trim()
            if (',' in value) return null
            val dash = value.indexOf('-')
            if (dash < 0) return null
            val a = value.substring(0, dash).trim()
            val b = value.substring(dash + 1).trim()
            if (a.isEmpty()) {
                // "bytes=-500": the last 500 bytes.
                val suffix = b.toLongOrNull() ?: return null
                if (suffix <= 0 || length == 0L) return UNSATISFIABLE
                return (length - suffix).coerceAtLeast(0)..(length - 1)
            }
            val start = a.toLongOrNull() ?: return null
            if (start < 0) return null
            val end = if (b.isEmpty()) length - 1 else (b.toLongOrNull() ?: return null).coerceAtMost(length - 1)
            if (start >= length || end < start) return UNSATISFIABLE
            return start..end
        }
    }
}
