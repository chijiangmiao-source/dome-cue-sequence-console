import { expect, test, type Page, type Route } from "@playwright/test";

const fixture = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url).pathname;

async function importSession(page: Page, file: string, name: string) {
  await page.getByTestId("import-input").setInputFiles(fixture(file));
  await expect(page.getByTestId("session-name")).toHaveText(name);
}

test.describe.serial("穹幕保险台端到端", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("app")).toHaveAttribute("data-loaded", "true");
  });

  test("导入场次并逐条确认", async ({ page }) => {
    await importSession(page, "session-a.json", "A 场 · 曙光");
    await expect(page.getByTestId("cue-row")).toHaveCount(3);

    await page.getByTestId("trigger-btn").click();
    await expect(page.getByTestId("confirmed-row")).toHaveCount(1);
    await expect(page.getByTestId("confirmed-row").first()).toContainText(
      "a-lights-up",
    );
    await expect(page.getByTestId("current-seq")).toContainText("1 / 3");

    await page.getByTestId("trigger-btn").click();
    await expect(page.getByTestId("confirmed-row")).toHaveCount(2);
    await expect(page.getByTestId("current-seq")).toContainText("2 / 3");
  });

  test("断网时指令留在浏览器队列，恢复后按序确认且无缺口", async ({
    page,
    context,
  }) => {
    await importSession(page, "session-a.json", "A 场 · 曙光");
    await page.getByTestId("trigger-btn").click();
    await expect(page.getByTestId("confirmed-row")).toHaveCount(1);

    await context.setOffline(true);
    await expect(page.getByTestId("conn-status")).toContainText("离线");

    // 断网连续触发两条：只进队列，不进已确认画面
    await page.getByTestId("trigger-btn").click();
    await page.getByTestId("trigger-btn").click();
    await expect(page.getByTestId("pending-row")).toHaveCount(2);
    await expect(page.getByTestId("confirmed-row")).toHaveCount(1);

    await context.setOffline(false);
    await expect(page.getByTestId("conn-status")).toContainText("在线");
    await expect(page.getByTestId("confirmed-row")).toHaveCount(3);
    await expect(page.getByTestId("pending-row")).toHaveCount(0);

    const rows = page.getByTestId("confirmed-row");
    await expect(rows.nth(0)).toContainText("#1");
    await expect(rows.nth(1)).toContainText("#2");
    await expect(rows.nth(2)).toContainText("#3");
  });

  test("场次切换：旧场迟到包被隔离，页面只显示新场确认序列", async ({
    page,
  }) => {
    await importSession(page, "session-a.json", "A 场 · 曙光");
    await page.getByTestId("trigger-btn").click();
    await expect(page.getByTestId("confirmed-row")).toHaveCount(1);

    const stateA = await (await page.request.get("/api/state")).json();
    const epochA = stateA.session.epoch as string;

    // 拦截推进请求，制造一条“在途”的旧场指令
    let held: Route | null = null;
    await page.route("**/api/advance", (route) => {
      held = route;
    });
    await page.getByTestId("trigger-btn").click();
    await expect
      .poll(() => held !== null, { timeout: 10_000 })
      .toBe(true);

    // 导播切换到 B 场
    await importSession(page, "session-b.json", "B 场 · 深海");
    await expect(page.getByTestId("confirmed-empty")).toBeVisible();
    await expect(page.getByTestId("current-seq")).toContainText("0 / 3");

    // 在途旧场指令收到旧 epoch 拒绝 → 进入隔离区
    await held!.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        detail: {
          error: "stale_epoch",
          message: "epoch 不属于当前活动场次，请求被隔离",
          cursor: null,
        },
      }),
    });
    await expect(page.getByTestId("isolated-row")).toHaveCount(1);
    await page.unroute("**/api/advance");

    // 旧场迟到包直达服务端 → 409 隔离，页面不受影响
    const late = await page.request.post("/api/advance", {
      data: {
        operation_id: `late-${crypto.randomUUID()}`,
        epoch: epochA,
        seq: 2,
        cue_id: "a-narration-1",
      },
    });
    expect(late.status()).toBe(409);
    expect((await late.json()).detail.error).toBe("stale_epoch");
    await expect(page.getByTestId("session-name")).toHaveText("B 场 · 深海");
    await expect(page.getByTestId("confirmed-empty")).toBeVisible();

    // 新场正常推进；同一 operation_id 重放返回原确认，页面无重复
    await page.getByTestId("trigger-btn").click();
    await expect(page.getByTestId("confirmed-row")).toHaveCount(1);

    const stateB = await (await page.request.get("/api/state")).json();
    const op = `replay-${crypto.randomUUID()}`;
    const r1 = await page.request.post("/api/advance", {
      data: {
        operation_id: op,
        epoch: stateB.session.epoch,
        seq: 2,
        cue_id: "b-whale",
      },
    });
    expect(r1.status()).toBe(200);
    const r2 = await page.request.post("/api/advance", {
      data: {
        operation_id: op,
        epoch: stateB.session.epoch,
        seq: 2,
        cue_id: "b-whale",
      },
    });
    expect((await r2.json()).duplicate).toBe(true);

    await expect(page.getByTestId("confirmed-row")).toHaveCount(2);
    const rows = page.getByTestId("confirmed-row");
    await expect(rows.nth(0)).toContainText("b-dive");
    await expect(rows.nth(1)).toContainText("b-whale");
  });

  test("切场后旧场状态快照延迟返回，画面始终停留在新场", async ({ page }) => {
    await importSession(page, "session-a.json", "A 场 · 曙光");
    await page.getByTestId("trigger-btn").click();
    await expect(page.getByTestId("confirmed-row")).toHaveCount(1);

    // 抓取旧场快照（稍后作为“迟到响应”回放）
    const staleA = await (await page.request.get("/api/state")).json();
    expect(staleA.session.name).toBe("A 场 · 曙光");

    // 挂起下一次状态轮询（模拟切场前发出、切场后才返回的请求）
    let held: Route | null = null;
    await page.route("**/api/state", async (route) => {
      if (!held) {
        held = route;
        return;
      }
      await route.continue();
    });
    await expect.poll(() => held !== null, { timeout: 10_000 }).toBe(true);

    // 切换到 B 场并确认一条新场提示
    await importSession(page, "session-b.json", "B 场 · 深海");
    await page.getByTestId("trigger-btn").click();
    await expect(page.getByTestId("confirmed-row")).toHaveCount(1);
    await expect(page.getByTestId("confirmed-row").first()).toContainText(
      "b-dive",
    );

    // 旧场快照迟到返回：必须被丢弃，不得回退画面、不得误隔离新场指令
    await held!.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(staleA),
    });
    await page.unroute("**/api/state");
    await page.waitForTimeout(600); // 给错误实现留出回退窗口

    await expect(page.getByTestId("session-name")).toHaveText("B 场 · 深海");
    await expect(page.getByTestId("current-seq")).toContainText("1 / 3");
    await expect(page.getByTestId("confirmed-row")).toHaveCount(1);
    await expect(page.getByTestId("confirmed-row").first()).toContainText(
      "b-dive",
    );
    await expect(page.getByTestId("isolated-row")).toHaveCount(0);
    await expect(page.getByTestId("pending-row")).toHaveCount(0);
  });

  test("冲突项保持待处理并显示期望序号", async ({ page, context }) => {
    await importSession(page, "session-c.json", "C 场 · 风暴");
    const state = await (await page.request.get("/api/state")).json();
    const epoch = state.session.epoch as string;

    // 断网排入一条 #1
    await context.setOffline(true);
    await page.getByTestId("trigger-btn").click();
    await expect(page.getByTestId("pending-row")).toHaveCount(1);

    // 离线期间另一路已推进 #1（到达顺序被打乱）
    const direct = await page.request.post("/api/advance", {
      data: {
        operation_id: `direct-${crypto.randomUUID()}`,
        epoch,
        seq: 1,
        cue_id: "c-wind",
      },
    });
    expect(direct.status()).toBe(200);

    // 恢复网络：队列中的 #1 被服务端以缺口拒绝 → 冲突待处理，期望序号 2
    await context.setOffline(false);
    await expect(page.getByTestId("conflict-badge")).toContainText("期望序号 2");
    await expect(page.getByTestId("pending-row")).toHaveCount(1);
    await expect(page.getByTestId("confirmed-row")).toHaveCount(1);
    await expect(page.getByTestId("confirmed-row").first()).toContainText(
      "c-wind",
    );

    // 服务端确认序列无缺口、无重复
    const finalState = await (await page.request.get("/api/state")).json();
    expect(finalState.session.confirmed.map((c: { seq: number }) => c.seq)).toEqual([
      1,
    ]);
  });
});
