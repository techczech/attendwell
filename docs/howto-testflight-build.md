# Getting a new iPad build onto the iPad through TestFlight

FOR DOMINIK. Agents: paste the numbered steps below into your message every time a new iPad build needs his action. He does this rarely and does not remember the clicks.

## What happens to a build

1. An agent builds the iPad app on the Mac and uploads it to Apple. The upload log says "Upload succeeded".
2. Apple processes the build. This takes 5 to 30 minutes. While it does, the build shows as **Processing**, and Apple emails you if anything is wrong with it.
3. The finished build sits in App Store Connect under its version number, for example **1.0.1 (2)**: version 1.0.1, build 2.
4. **It reaches no one until it is in a tester group.** Builds uploaded from Xcode are never added to a group automatically, so each one has to be added by hand. This is the step that usually gets missed.
5. Once the build is in your group, the TestFlight app on the iPad offers it within a few minutes.

## Steps: make the build appear on the iPad

1. On the Mac, open [App Store Connect](https://appstoreconnect.apple.com) and sign in with your Apple developer account.
2. Click **Apps**, then **AttendWell** (the iPad app).
3. Click the **TestFlight** tab at the top.
4. In the build list, find the new build (for example **1.0.1 (2)**). Its status tells you what to do:
   - **Processing**: wait 30 minutes and look again.
   - **Missing Compliance**: click the build, answer **None of the algorithms mentioned above**, and save. Then carry on with step 5.
   - **Ready to Submit** or **Ready to Test**: carry on with step 5.
   - **Waiting for Review**: the build is in an external group, which Apple reviews first, usually within a day. To skip the wait, also add it to an internal group (step 5).
   - **Invalid**, or the build is not in the list at all: tell the agent; it needs uploading again.
5. In the left sidebar, under **Internal Testing**, click your tester group.
6. Click the **Builds** tab, then **+**, tick the new build, and click **Add**.
7. There is no way round step 6 for builds uploaded from this Mac: the group's Settings tab says "Build Distribution: Manual for Xcode Builds" and cannot be changed. Only an App Store Connect API key lets an agent add the build for you.
8. On the iPad, open the **TestFlight** app, tap **AttendWell**, and tap **Update** (or **Install**).

How to tell it worked: Apple emails "AttendWell 1.0.1 (2) for iOS is now available to test". In App Store Connect the build may still say **Ready to Submit**. That only matters for external groups, which Apple reviews. Your internal group gets the build anyway.

## Redeem codes and new iPads

You don't need a redeem code. TestFlight only gives those to external testers. You are an internal tester, invited on 28 Oct 2026, and every iPad signed in to TestFlight with your Apple ID sees the app.

For an iPad signed in to someone else's Apple ID, either sign its App Store into your own Apple ID (Settings → your name → Media & Purchases → Sign Out, then sign in with yours; iCloud stays as it is), or get a redeem code. A redeem code only comes in an **external** tester invitation email, and external builds pass Apple's beta review first (usually within a day):

1. App Store Connect → Apps → AttendWell → TestFlight.
2. Sidebar, **External Testing** → **+** → name the group "Other iPads" → **Create**.
3. **Testers** tab → **+** → **Add New Testers** → an address you read, e.g. your own address with "+ipad" added before the @ → **Add**.
4. **Builds** tab → **+** → pick the build → **Next** → write one line in "What to Test" → **Submit for Review**. The first time, Apple also asks for a short app description, a feedback email and contact details. Say no sign-in is needed (the app has "Try a demo").
5. When Apple approves the build, the invitation goes to that address. The redeem code is in the email.
6. On the iPad: TestFlight → **Redeem** → type the code → **Install**.

To set up an iPad that has never had AttendWell: install **TestFlight** from the App Store, sign in with your Apple ID, then open the email "DOMINIK LUKES has invited you to test AttendWell" (28 Oct 2026) on that iPad and tap **View in TestFlight**.

## Doing without these steps

Agents can do steps 4 to 7 themselves with an App Store Connect API key. To make one: App Store Connect → **Users and Access** → **Integrations** → **Team Keys** → **+**, name it "AttendWell agent", role **App Manager**, then **Generate**. Download the `.p8` file (Apple only lets you download it once) and give it to the agent through the secret request card, never in chat, together with the Key ID and Issuer ID shown on that page.
