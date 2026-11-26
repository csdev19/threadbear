package com.mikerosoft.threadbear.kit

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class StartRequestTest {
    private val full = """{"docId":"d1","requestId":"q1","threadId":"t1","runnerId":"r1","target":"bruce","text":"Do the thing\nin full",
        "title":"Fix it","cwd":"/w","model":"opus","effort":"high","permissionMode":"plan","why":"Needs a Linux box","createdAt":12.0,"runnerName":"M5","extra":1}"""

    @Test fun readsEveryField() {
        val r = StartRequest.read(parseJson(full) as kotlinx.serialization.json.JsonObject)
        assertEquals("d1", r.docId)
        assertEquals("bruce", r.target)
        assertEquals("Do the thing\nin full", r.text)
        assertEquals("/w", r.cwd)
        assertEquals("plan", r.permissionMode)
        assertEquals("opus", r.model)
        assertEquals("M5", r.runnerName)
        assertEquals("M5", r.asking)
    }

    @Test fun optionalFieldsMayBeMissing() {
        val r = StartRequest.read(parseJson("""{"docId":"d","requestId":"q","threadId":"t","runnerId":"r1","target":"bruce","text":"go"}""") as kotlinx.serialization.json.JsonObject)
        assertNull(r.cwd); assertNull(r.model); assertNull(r.runnerName); assertNull(r.title)
        assertEquals("r1", r.asking)
    }

    @Test fun nullAnswerMeansNotStartable() = runTest {
        val t = FakeTransport()
        assertNull(PhoneBackend(t, "tok").startRequest("t1", "a1"))
        assertEquals("phone:startRequest", t.calls.single().first)
        assertEquals(setOf("token", "threadId", "approvalId"), t.calls.single().second.keys)
    }

    @Test fun rowAnswerIsRead() = runTest {
        val t = FakeTransport().apply { queries = { _, _ -> full } }
        assertEquals("d1", PhoneBackend(t, "tok").startRequest("t1", "a1")?.docId)
    }

    @Test fun startSendsExactlyTheFourArgs() = runTest {
        val t = FakeTransport()
        assertEquals("cmd1", PhoneBackend(t, "tok").startRequestNow("t1", "a1", "d1"))
        assertEquals("phone:startRequestNow", t.calls.single().first)
        assertEquals(setOf("token", "threadId", "approvalId", "docId"), t.calls.single().second.keys)
        assertEquals("\"d1\"", t.calls.single().second["docId"].toString())
    }

    @Test fun commandResultNamesTheStartedThread() {
        val s = CommandStatus.read(parseJson("""{"state":"done","result":{"thread":{"id":"n1","runnerId":"r2","runnerName":"bruce"}}}""") as kotlinx.serialization.json.JsonObject)
        assertEquals("bruce", s.started?.runnerName)
        assertEquals("n1", s.started?.id)
        assertTrue(s.commands == null)
        val none = CommandStatus.read(parseJson("""{"state":"done"}""") as kotlinx.serialization.json.JsonObject)
        assertNull(none.started)
    }

    private fun mode(m: String?) = StartRequest("d", "q", "t", "r", "bruce", "go", permissionMode = m).permissionLine

    @Test fun permissionLineAlwaysNamesTheModeThatWillApply() {
        assertEquals("Full access (none asked for)", mode(null))
        assertEquals("Full access (none asked for)", mode(""))
        assertEquals("Full access", mode("full"))
        assertEquals("Asks before edits", mode("ask"))
        assertEquals("Auto", mode("auto"))
        assertEquals("Plan first", mode("plan"))
        assertEquals("Unknown (weird)", mode("weird"))
    }
}
