package app.valence.core

/**
 * Node's `path.posix` functions the desktop's m3u code uses, ported line for line. [resolve] uses a
 * virtual working directory of `/` (library-relative paths never climb above the root).
 */
object Posix {
    private fun normalizeString(path: String, allowAboveRoot: Boolean): String {
        var res = ""
        var lastSegmentLength = 0
        var lastSlash = -1
        var dots = 0
        var code = 0
        var i = 0
        while (i <= path.length) {
            if (i < path.length) {
                code = path[i].code
            } else if (code == '/'.code) {
                break
            } else {
                code = '/'.code
            }
            if (code == '/'.code) {
                if (lastSlash == i - 1 || dots == 1) {
                    // noop
                } else if (dots == 2) {
                    if (res.length < 2 || lastSegmentLength != 2 || res[res.length - 1] != '.' || res[res.length - 2] != '.') {
                        if (res.length > 2) {
                            val lastSlashIndex = res.lastIndexOf('/')
                            if (lastSlashIndex == -1) {
                                res = ""
                                lastSegmentLength = 0
                            } else {
                                res = res.substring(0, lastSlashIndex)
                                lastSegmentLength = res.length - 1 - res.lastIndexOf('/')
                            }
                            lastSlash = i
                            dots = 0
                            i++
                            continue
                        } else if (res.isNotEmpty()) {
                            res = ""
                            lastSegmentLength = 0
                            lastSlash = i
                            dots = 0
                            i++
                            continue
                        }
                    }
                    if (allowAboveRoot) {
                        res += if (res.isNotEmpty()) "/.." else ".."
                        lastSegmentLength = 2
                    }
                } else {
                    res = if (res.isNotEmpty()) res + "/" + path.substring(lastSlash + 1, i) else path.substring(lastSlash + 1, i)
                    lastSegmentLength = i - lastSlash - 1
                }
                lastSlash = i
                dots = 0
            } else if (code == '.'.code && dots != -1) {
                ++dots
            } else {
                dots = -1
            }
            i++
        }
        return res
    }

    fun normalize(p: String): String {
        if (p.isEmpty()) return "."
        val isAbsolute = p[0] == '/'
        val trailingSeparator = p[p.length - 1] == '/'
        var path = normalizeString(p, !isAbsolute)
        if (path.isEmpty()) {
            if (isAbsolute) return "/"
            return if (trailingSeparator) "./" else "."
        }
        if (trailingSeparator) path += "/"
        return if (isAbsolute) "/$path" else path
    }

    fun join(vararg parts: String): String {
        val nonEmpty = parts.filter { it.isNotEmpty() }
        if (nonEmpty.isEmpty()) return "."
        return normalize(nonEmpty.joinToString("/"))
    }

    fun resolve(vararg parts: String): String {
        var resolvedPath = ""
        var resolvedAbsolute = false
        var i = parts.size - 1
        while (i >= -1 && !resolvedAbsolute) {
            val path = if (i >= 0) parts[i] else "/"
            i--
            if (path.isEmpty()) continue
            resolvedPath = "$path/$resolvedPath"
            resolvedAbsolute = path[0] == '/'
        }
        resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute)
        if (resolvedAbsolute) return "/$resolvedPath"
        return resolvedPath.ifEmpty { "." }
    }

    fun relative(fromIn: String, toIn: String): String {
        if (fromIn == toIn) return ""
        val from = resolve(fromIn)
        val to = resolve(toIn)
        if (from == to) return ""
        val fromStart = 1
        val fromEnd = from.length
        val fromLen = fromEnd - fromStart
        val toStart = 1
        val toLen = to.length - toStart
        val length = if (fromLen < toLen) fromLen else toLen
        var lastCommonSep = -1
        var i = 0
        while (i < length) {
            val fromCode = from[fromStart + i]
            if (fromCode != to[toStart + i]) break
            else if (fromCode == '/') lastCommonSep = i
            i++
        }
        if (i == length) {
            if (toLen > length) {
                if (to[toStart + i] == '/') return to.substring(toStart + i + 1)
                if (i == 0) return to.substring(toStart + i)
            } else if (fromLen > length) {
                if (from[fromStart + i] == '/') lastCommonSep = i
                else if (i == 0) lastCommonSep = 0
            }
        }
        val out = StringBuilder()
        i = fromStart + lastCommonSep + 1
        while (i <= fromEnd) {
            if (i == fromEnd || from[i] == '/') out.append(if (out.isEmpty()) ".." else "/..")
            i++
        }
        return out.toString() + to.substring(toStart + lastCommonSep)
    }

    fun dirname(path: String): String {
        if (path.isEmpty()) return "."
        val hasRoot = path[0] == '/'
        var end = -1
        var matchedSlash = true
        var i = path.length - 1
        while (i >= 1) {
            if (path[i] == '/') {
                if (!matchedSlash) {
                    end = i
                    break
                }
            } else {
                matchedSlash = false
            }
            i--
        }
        if (end == -1) return if (hasRoot) "/" else "."
        if (hasRoot && end == 1) return "//"
        return path.substring(0, end)
    }
}
