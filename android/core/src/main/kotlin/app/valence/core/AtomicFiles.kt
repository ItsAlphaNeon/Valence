package app.valence.core

import java.io.File
import java.io.FileOutputStream
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/** Atomic file replacement the desktop's way: write `<file>.valence-tmp`, fsync, rename over the target. */
object AtomicFiles {
    const val TMP_SUFFIX = ".valence-tmp"

    fun write(file: File, bytes: ByteArray) {
        file.absoluteFile.parentFile?.mkdirs()
        val tmp = File(file.path + TMP_SUFFIX)
        try {
            FileOutputStream(tmp).use {
                it.write(bytes)
                it.fd.sync()
            }
            try {
                Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        } catch (e: Exception) {
            tmp.delete()
            throw e
        }
    }

    fun writeText(file: File, text: String) = write(file, text.toByteArray(Charsets.UTF_8))
}
