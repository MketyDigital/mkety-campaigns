test("campaign worker does not claim jobs while the global emergency stop is active", async () => {
  let claimed = false;
  const repository = fakeRepository({
    async isEmergencyStopActive() { return true; },
    async claimNext() { claimed = true; return job; },
  });
  assert.equal(await createEmailCampaignWorker(repository, fakeProvider(), true).processOne(), false);
  assert.equal(claimed, false);
});

