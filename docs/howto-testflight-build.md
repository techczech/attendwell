# Getting a new iPad build onto the iPad through TestFlight

FOR DOMINIK. Agents: paste the numbered steps below into your message every time a new iPad build needs his action. He does this rarely and does not remember the clicks.

## What happens to a build

1. An agent builds the iPad app on the Mac and uploads it to Apple. The upload log says "Upload succeeded".
2. Apple processes the build. This takes 5 to 30 minutes. While it does, the build shows as **Processing**, and Apple emails you if anything is wrong with it.
3. The finished build sits in App Store Connect under its version number, for example **1.0.1 (2)**: version 1.0.1, build 2.
4. **It reaches no one until it is in a tester group.** A group only picks up new builds by itself if its "Automatic distribution" setting is on. Otherwise someone has to add each build by hand. This is the step that usually gets missed.
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
7. Optional, to avoid this next time: on the same group page, turn on **Automatic distribution**. New builds then go to the group without step 6.
8. On the iPad, open the **TestFlight** app, tap **AttendWell**, and tap **Update** (or **Install**).

## Doing without these steps

Agents can do steps 4 to 7 themselves with an App Store Connect API key. To make one: App Store Connect → **Users and Access** → **Integrations** → **Team Keys** → **+**, name it "AttendWell agent", role **App Manager**, then **Generate**. Download the `.p8` file (Apple only lets you download it once) and give it to the agent through the secret request card, never in chat, together with the Key ID and Issuer ID shown on that page.
