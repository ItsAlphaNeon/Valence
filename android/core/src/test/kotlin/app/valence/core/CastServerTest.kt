package app.valence.core

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.InetAddress
import java.net.Socket
import java.util.concurrent.Callable
import java.util.concurrent.Executors

class CastServerTest {
    private lateinit var dir: File
    private lateinit var song: File
    private lateinit var server: CastServer
    private val data = ByteArray(300_000) { (it * 31 % 251).toByte() }
    private val cover = byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
    private val token get() = server.token

    @Before
    fun setUp() {
        dir = File.createTempFile("cast", "").apply { delete(); mkdirs() }
        song = File(dir, "song.mp3").apply { writeBytes(data) }
        server = CastServer(
            InetAddress.getLoopbackAddress(),
            audio = { id -> if (id == 7L) CastContent.OfFile(song, "audio/mpeg") else null },
            art = { id -> if (id == 7L) CastContent.OfBytes(cover, "image/jpeg") else null },
        )
        server.start()
    }

    @After
    fun tearDown() {
        server.stop()
        dir.deleteRecursively()
    }

    private class Response(val status: Int, val headers: Map<String, String>, val body: ByteArray)

    private fun request(method: String, target: String, vararg headers: String): Response =
        Socket(InetAddress.getLoopbackAddress(), server.port).use { s ->
            val head = buildString {
                append("$method $target HTTP/1.1\r\nHost: x\r\n")
                headers.forEach { append(it).append("\r\n") }
                append("\r\n")
            }
            s.getOutputStream().write(head.toByteArray())
            s.getOutputStream().flush()
            val all = ByteArrayOutputStream().also { s.getInputStream().copyTo(it) }.toByteArray()
            val split = String(all, Charsets.ISO_8859_1).indexOf("\r\n\r\n")
            val lines = String(all, 0, split, Charsets.ISO_8859_1).split("\r\n")
            Response(
                lines[0].split(' ')[1].toInt(),
                lines.drop(1).associate { it.substringBefore(':').lowercase() to it.substringAfter(':').trim() },
                all.copyOfRange(split + 4, all.size),
            )
        }

    @Test
    fun `serves a whole song`() {
        val r = request("GET", "/$token/audio/7.mp3")
        assertEquals(200, r.status)
        assertEquals("audio/mpeg", r.headers["content-type"])
        assertEquals("${data.size}", r.headers["content-length"])
        assertEquals("bytes", r.headers["accept-ranges"])
        assertEquals("*", r.headers["access-control-allow-origin"])
        assertArrayEquals(data, r.body)
    }

    @Test
    fun `serves the urls it hands out`() {
        val audio = java.net.URI(server.audioUrl(7, "mp3")).path
        assertEquals(200, request("HEAD", audio).status)
        val art = java.net.URI(server.artUrl(7)).path
        assertArrayEquals(cover, request("GET", art).body)
    }

    @Test
    fun `head sends the headers and no body`() {
        val r = request("HEAD", "/$token/audio/7.mp3")
        assertEquals(200, r.status)
        assertEquals("${data.size}", r.headers["content-length"])
        assertEquals(0, r.body.size)
    }

    @Test
    fun `serves ranges`() {
        val mid = request("GET", "/$token/audio/7.mp3", "Range: bytes=1000-1999")
        assertEquals(206, mid.status)
        assertEquals("bytes 1000-1999/${data.size}", mid.headers["content-range"])
        assertEquals("1000", mid.headers["content-length"])
        assertArrayEquals(data.copyOfRange(1000, 2000), mid.body)

        val open = request("GET", "/$token/audio/7.mp3", "range: bytes=299990-")
        assertEquals(206, open.status)
        assertArrayEquals(data.copyOfRange(299_990, data.size), open.body)

        val tail = request("GET", "/$token/audio/7.mp3", "Range: bytes=-5")
        assertEquals(206, tail.status)
        assertArrayEquals(data.copyOfRange(data.size - 5, data.size), tail.body)

        val pastEnd = request("GET", "/$token/audio/7.mp3", "Range: bytes=299990-999999999")
        assertEquals(206, pastEnd.status)
        assertEquals("bytes 299990-299999/${data.size}", pastEnd.headers["content-range"])
    }

    @Test
    fun `ranges work on bytes too`() {
        val r = request("GET", "/$token/art/7", "Range: bytes=2-4")
        assertEquals(206, r.status)
        assertArrayEquals(byteArrayOf(3, 4, 5), r.body)
    }

    @Test
    fun `a range past the end is refused`() {
        val r = request("GET", "/$token/audio/7.mp3", "Range: bytes=300000-")
        assertEquals(416, r.status)
        assertEquals("bytes */${data.size}", r.headers["content-range"])
        assertEquals(0, r.body.size)
    }

    @Test
    fun `a range it can't use sends the whole song`() {
        for (h in listOf("Range: items=1-2", "Range: bytes=1-2,5-6", "Range: bytes=x-y")) {
            val r = request("GET", "/$token/audio/7.mp3", h)
            assertEquals(h, 200, r.status)
            assertEquals(h, data.size, r.body.size)
        }
    }

    @Test
    fun `needs the token`() {
        assertEquals(404, request("GET", "/audio/7.mp3").status)
        assertEquals(404, request("GET", "/nope/audio/7.mp3").status)
        assertEquals(404, request("GET", "/").status)
    }

    @Test
    fun `only track ids reach the lookup`() {
        val seen = mutableListOf<Long>()
        val s = CastServer(InetAddress.getLoopbackAddress(), { seen.add(it); null }, { seen.add(it); null })
        s.start()
        try {
            val t = s.token
            for (target in listOf(
                "/$t/audio/../../etc/passwd", "/$t/audio/..%2f..%2fetc%2fpasswd", "/$t/audio/song.mp3",
                "/$t/secrets/7", "/$t/audio", "/$t/audio/7/8", "/$t/audio/", "/$t/audio/-",
            )) {
                val status = Socket(InetAddress.getLoopbackAddress(), s.port).use { c ->
                    c.getOutputStream().write("GET $target HTTP/1.1\r\n\r\n".toByteArray())
                    String(c.getInputStream().readBytes(), Charsets.ISO_8859_1).split(' ')[1].toInt()
                }
                assertEquals(target, 404, status)
            }
            assertTrue(seen.toString(), seen.isEmpty())
        } finally {
            s.stop()
        }
    }

    @Test
    fun `unknown track and deleted file are not found`() {
        assertEquals(404, request("GET", "/$token/audio/8.mp3").status)
        assertEquals(404, request("GET", "/$token/art/8").status)
        song.delete()
        assertEquals(404, request("GET", "/$token/audio/7.mp3").status)
    }

    @Test
    fun `read only`() {
        assertEquals(405, request("POST", "/$token/audio/7.mp3").status)
        assertEquals(405, request("DELETE", "/$token/audio/7.mp3").status)
        assertEquals(405, request("PUT", "/$token/audio/7.mp3").status)
    }

    @Test
    fun `answers a browser's preflight`() {
        val r = request("OPTIONS", "/$token/audio/7.mp3", "Access-Control-Request-Private-Network: true")
        assertEquals(204, r.status)
        assertEquals("true", r.headers["access-control-allow-private-network"])
    }

    @Test
    fun `junk gets an answer, not a hang`() {
        Socket(InetAddress.getLoopbackAddress(), server.port).use { s ->
            s.getOutputStream().write("hello\r\n\r\n".toByteArray())
            assertTrue(String(s.getInputStream().readBytes(), Charsets.ISO_8859_1).startsWith("HTTP/1.1 400"))
        }
    }

    @Test
    fun `serves several at once`() {
        val pool = Executors.newFixedThreadPool(8)
        try {
            val results = (0 until 8).map { pool.submit(Callable { request("GET", "/$token/audio/7.mp3") }) }.map { it.get() }
            results.forEach {
                assertEquals(200, it.status)
                assertArrayEquals(data, it.body)
            }
        } finally {
            pool.shutdownNow()
        }
    }

    @Test
    fun `a client that leaves doesn't stop it`() {
        Socket(InetAddress.getLoopbackAddress(), server.port).use { s ->
            s.getOutputStream().write("GET /$token/audio/7.mp3 HTTP/1.1\r\n\r\n".toByteArray())
            s.getInputStream().read()
        }
        assertEquals(200, request("HEAD", "/$token/audio/7.mp3").status)
    }

    @Test
    fun `stop closes the port`() {
        val port = server.port
        server.stop()
        val refused = runCatching { Socket(InetAddress.getLoopbackAddress(), port).close() }.isFailure
        assertTrue(refused)
        assertEquals(-1, server.port)
    }

    @Test
    fun `parses ranges`() {
        assertEquals(0L..9L, CastServer.parseRange("bytes=0-9", 100))
        assertEquals(90L..99L, CastServer.parseRange("bytes=90-", 100))
        assertEquals(90L..99L, CastServer.parseRange("bytes=-10", 100))
        assertEquals(0L..99L, CastServer.parseRange("bytes=-500", 100))
        assertEquals(CastServer.UNSATISFIABLE, CastServer.parseRange("bytes=100-", 100))
        assertEquals(CastServer.UNSATISFIABLE, CastServer.parseRange("bytes=5-1", 100))
        assertEquals(CastServer.UNSATISFIABLE, CastServer.parseRange("bytes=0-", 0))
        assertEquals(CastServer.UNSATISFIABLE, CastServer.parseRange("bytes=-0", 100))
        assertNull(CastServer.parseRange("items=0-9", 100))
        assertNull(CastServer.parseRange("bytes=a-b", 100))
        assertNull(CastServer.parseRange("bytes=0-1,3-4", 100))
    }

    @Test
    fun `knows the library's formats`() {
        assertEquals("audio/mpeg", CastServer.audioMime("a.MP3"))
        assertEquals("audio/ogg", CastServer.audioMime("a b.opus"))
        assertEquals("audio/flac", CastServer.audioMime("x.flac"))
        assertEquals("audio/mp4", CastServer.audioMime("y.m4a"))
        assertEquals("application/octet-stream", CastServer.audioMime("noext"))
    }
}
