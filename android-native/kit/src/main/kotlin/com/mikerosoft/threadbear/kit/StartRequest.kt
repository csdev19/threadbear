package com.mikerosoft.threadbear.kit

import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject

/**
 * A request another Mac filed to start a thread on `target` (backend API 106,
 * phone:startRequest). The phone draws the card from this row, never from the
 * card's title: `text` is the whole brief the new thread would be given.
 */
data class StartRequest(
    val docId: String,
    val requestId: String,
    val threadId: String,
    val runnerId: String,
    /** The Mac name the request asks for. */
    val target: String,
    val text: String,
    val title: String? = null,
    val cwd: String? = null,
    val model: String? = null,
    val effort: String? = null,
    val permissionMode: String? = null,
    val why: String? = null,
    val runnerName: String? = null,
) {
    /** Who's asking: the Mac's name, or its id when the backend didn't say. */
    val asking: String get() = runnerName?.takeIf { it.isNotBlank() } ?: runnerId

    /**
     * The access the new thread will really have, never a blank: the relay
     * starts a request filed with no mode on Full access (convex/relay.ts,
     * "create"), so the phone says so. Same names as the Mac app's request card.
     */
    val permissionLine: String get() = when (permissionMode) {
        null, "" -> "Full access (none asked for)"
        "full" -> "Full access"
        "ask" -> "Asks before edits"
        "auto" -> "Auto"
        "plan" -> "Plan first"
        else -> "Unknown ($permissionMode)"
    }

    companion object {
        /** The approval name of the card a request shows on its asking thread. */
        const val CARD_NAME = "threadbear.start_thread"

        fun read(o: JsonObject) = StartRequest(
            docId = o.needStr("docId"),
            requestId = o.str("requestId") ?: "",
            threadId = o.needStr("threadId"),
            runnerId = o.needStr("runnerId"),
            target = o.needStr("target"),
            text = o.needStr("text"),
            title = o.str("title"),
            cwd = o.str("cwd"),
            model = o.str("model"),
            effort = o.str("effort"),
            permissionMode = o.str("permissionMode"),
            why = o.str("why"),
            runnerName = o.str("runnerName"),
        )
    }
}

/** The thread a start request made, from the command's result. */
data class StartedThread(val id: String, val runnerId: String?, val runnerName: String?) {
    companion object {
        fun read(o: JsonObject): StartedThread? {
            val t = o.obj("thread") ?: return null
            return StartedThread(t.str("id") ?: return null, t.str("runnerId"), t.str("runnerName"))
        }
    }
}

/**
 * What reading a start card's request came to: a request to show, a card that
 * can't be started from the phone (the backend said null), or a read that
 * failed, which isn't the same: it can be tried again.
 */
sealed interface StartRequestRead {
    data class Startable(val request: StartRequest) : StartRequestRead
    data object NotStartable : StartRequestRead
    data object Unreadable : StartRequestRead
}

/** A read that takes longer than [timeoutMs] is [StartRequestRead.Unreadable], which offers Try again and Don't. */
suspend fun PhoneBackend.readStartRequest(threadId: String, approvalId: String, timeoutMs: Long = START_REQUEST_READ_TIMEOUT_MS): StartRequestRead = try {
    withTimeoutOrNull(timeoutMs) { startRequest(threadId, approvalId)?.let { StartRequestRead.Startable(it) } ?: StartRequestRead.NotStartable }
        ?: StartRequestRead.Unreadable
} catch (e: CancellationException) {
    throw e
} catch (_: Exception) {
    StartRequestRead.Unreadable
}

const val START_REQUEST_READ_TIMEOUT_MS = 15_000L
