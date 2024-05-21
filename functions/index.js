/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

// The Cloud Functions for Firebase SDK to create Cloud Functions and triggers.
// const {logger} = require("firebase-functions");
const {onRequest} = require("firebase-functions/v2/https");
// const {onDocumentCreated} = require("firebase-functions/v2/firestore");

// The Firebase Admin SDK to access Firestore.
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
} = require("@google/generative-ai");

initializeApp();

const apiKey = process.env.AI_STUDIO_API_KEY;
const genAI = new GoogleGenerativeAI(apiKey);

// Take the text parameter passed to this HTTP endpoint and insert it into
// Firestore under the path /messages/:documentId/original
exports.getUserPosts = onRequest({
  region: "asia-southeast1",
}, async (req, res) => {
  // Grab the user type and email from the request
  const userType = req.query.type;
  const userEmail = req.query.email;

  const type = userType && userType === "learner" ? "tutor" : "learner";

  const db = getFirestore();

  const users = db.collection("all_users")
      .doc(userType).collection("users");

  const posts = db.collection("createdPosts")
      .doc(`createdPost_` + type).collection("users");

  const userRef = await users.where("userEmail", "==", userEmail).get();
  const postRef = await posts.get();

  const userPosts = [];
  const userData = [];

  // Iterate over userRef to get user data.
  userRef.forEach((doc) => {
    userData.push(doc.data());
  });

  const userTags = userData[0].userTag;
  const tags = JSON.stringify(userTags);

  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash-latest",
    // eslint-disable-next-line max-len
    systemInstruction: `You will be provided with a JSON array of tags, and your task is to sort the JSON Array according to the relevance of the tag in this JSON array: ` + tags,
  });

  const generationConfig = {
    temperature: 1,
    topP: 0.95,
    topK: 64,
    maxOutputTokens: 8192,
    responseMimeType: "application/json",
  };

  const safetySettings = [
    {
      category: HarmCategory.HARM_CATEGORY_HARASSMENT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
  ];

  const getRelevance = async (allPostTags) => {
    const chatSession = model.startChat({
      generationConfig,
      safetySettings,
    });

    const allTags = JSON.stringify(allPostTags);
    const result = await chatSession.sendMessage(allTags);
    return result.response.text();
  };

  // Iterate over postsRef to get all user posts based on type.
  postRef.forEach((doc) => {
    console.log(doc.id, "=>", doc.data());
    userPosts.push(doc.data());
  });

  // Get all unique tags
  const allPostTags = Array.from(new Set(userPosts.reduce((acc, item) => {
    return acc.concat(item.postTags.map((tag) => tag.toLowerCase()));
  }, [])));

  console.log(`All tags: ` + allPostTags);

  // Get new order of tags based on relevance
  const customOrder = await getRelevance(allPostTags);

  // Parse the result as an array
  const relevantTags = JSON.parse(customOrder);

  console.log(`Custom Order: ` + relevantTags);

  // Function to get the rank of the tag based on the order of relevance
  const getRank = (tags) => {
    for (let i = 0; i < relevantTags.length; i++) {
      if (tags.some((tag) => tag.toLowerCase() === relevantTags[i])) {
        return i;
      }
    }
    return relevantTags.length; // If no tags match, place at the end
  };

  // eslint-disable-next-line max-len
  const orderedData = userPosts.sort((a, b) => getRank(a.postTags) - getRank(b.postTags));

  res.json({results: orderedData});
});
