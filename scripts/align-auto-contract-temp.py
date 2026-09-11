from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f"{path}: expected {count} occurrence(s), found {actual}: {old[:160]!r}")
    p.write_text(text.replace(old, new, count))


replace(
    'src/runtime/permissions.mjs',
    "    if (auto && projectScoped) return { effect: 'allow', source: 'session-auto-project' };\n    return { effect: 'ask', autoEligible: auto ? projectScoped : safe };",
    "    if (auto && projectScoped) return { effect: 'allow', source: 'session-auto' };\n    return { effect: 'ask', autoEligible: auto ? projectScoped : safe };",
)

replace(
    'test/full-access-permissions.test.mjs',
    "      await broker.authorize({ sessionId: 's1', action: 'read', resources: ['.env'], projectRoot: root }),\n      { allowed: true, source: 'session-auto-project' },",
    "      await broker.authorize({ sessionId: 's1', action: 'read', resources: ['.env'], projectRoot: root }),\n      { allowed: true, source: 'session-auto' },",
)
replace(
    'test/full-access-permissions.test.mjs',
    "      await broker.authorize({ sessionId: 's1', action: 'edit', resources: ['.'], projectRoot: root }),\n      { allowed: true, source: 'session-auto-project' },",
    "      await broker.authorize({ sessionId: 's1', action: 'edit', resources: ['.'], projectRoot: root }),\n      { allowed: true, source: 'session-auto' },",
)

replace(
    'test/c1-permissions.test.mjs',
    """test('guarded auto is session-scoped and never bypasses sensitive files or symlink escapes', async () => {
  const { dir, root } = await fixture();
  const broker = new PermissionBroker();
  try {
    broker.setAuto('s1', true);
    assert.deepEqual(
      await broker.authorize({ sessionId: 's1', action: 'write', resources: ['src/new.js'], projectRoot: root }),
      { allowed: true, source: 'session-auto' },
    );
    assert.equal(await isSafeWorkspaceResource('escape/secret.txt', root), false);

    const sensitive = broker.authorize({ sessionId: 's1', action: 'edit', resources: ['.env'], projectRoot: root });
    const escaped = broker.authorize({ sessionId: 's1', action: 'read', resources: ['escape/secret.txt'], projectRoot: root });
    const requests = await waitPending(broker, 's1', 2);
    assert.equal(requests.every((request) => request.autoEligible === false), true);
    for (const request of requests) broker.reply(request.id, 'reject');
    await assert.rejects(sensitive, PermissionDeniedError);
    await assert.rejects(escaped, PermissionDeniedError);
  } finally { broker.close(); await rm(dir, { recursive: true, force: true }); }
});""",
    """test('guarded auto approves active-project actions but still guards symlink escapes', async () => {
  const { dir, root } = await fixture();
  const broker = new PermissionBroker();
  try {
    broker.setAuto('s1', true);
    assert.deepEqual(
      await broker.authorize({ sessionId: 's1', action: 'write', resources: ['src/new.js'], projectRoot: root }),
      { allowed: true, source: 'session-auto' },
    );
    assert.deepEqual(
      await broker.authorize({ sessionId: 's1', action: 'edit', resources: ['.env'], projectRoot: root }),
      { allowed: true, source: 'session-auto' },
    );
    assert.equal(await isSafeWorkspaceResource('escape/secret.txt', root), false);

    const escaped = broker.authorize({ sessionId: 's1', action: 'read', resources: ['escape/secret.txt'], projectRoot: root });
    const request = (await waitPending(broker, 's1'))[0];
    assert.equal(request.autoEligible, false);
    broker.reply(request.id, 'reject');
    await assert.rejects(escaped, PermissionDeniedError);
  } finally { broker.close(); await rm(dir, { recursive: true, force: true }); }
});""",
)
