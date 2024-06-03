/* eslint-disable max-len */
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
const {getFirestore, Filter} = require("firebase-admin/firestore");
const {getMessaging} = require("firebase-admin/messaging");
const {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
} = require("@google/generative-ai");
const nodemailer = require("nodemailer");
const cors = require("cors")({origin: true});

initializeApp();

const apiKey = process.env.AI_STUDIO_API_KEY;
const genAI = new GoogleGenerativeAI(apiKey);

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASSWORD,
  },
});

const getRelevance = async (tags, allPostTags) => {
  // Initialize Gemini AI Model
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash-latest",

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

  const chatSession = model.startChat({
    generationConfig,
    safetySettings,
  });

  const allTags = JSON.stringify(allPostTags);
  const result = await chatSession.sendMessage(allTags);
  return result.response.text();
};

exports.getUserPosts = onRequest({
  region: "asia-southeast1",
}, async (req, res) => {
  // Grab the user type and email from the request
  cors(req, res, async () => {
    const userType = req.query.userType;
    const userEmail = req.query.email;
    const query = req.query.query;
    const queryType = req.query.queryType;

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


    // Iterate over postsRef to get all user posts based on type.
    postRef.forEach((doc) => {
      console.log(doc.id, "=>", doc.data());
      userPosts.push(doc.data());
    });

    // Bubble sort function based on the maximum tag rank
    const bubbleSort = (array) => {
      const n = array.length;
      let swapped;
      do {
        swapped = false;
        for (let i = 0; i < n - 1; i++) {
          const maxRankA = getMaxTagRank(array[i].postTags);
          const maxRankB = getMaxTagRank(array[i + 1].postTags);
          if (maxRankA > maxRankB) {
            const temp = array[i];
            array[i] = array[i + 1];
            array[i + 1] = temp;
            swapped = true;
          }
        }
      } while (swapped);
      return array;
    };

    // Get all unique tags
    const allPostTags = Array.from(new Set(userPosts.reduce((acc, item) => {
      return acc.concat(item.postTags.map((tag) => tag.toLowerCase()));
    }, [])));

    console.log(`All tags: ` + allPostTags);

    // Get new order of tags based on relevance
    const customOrder = await getRelevance(tags, allPostTags);

    // Parse the result as an array
    const relevantTags = JSON.parse(customOrder);

    console.log(`Custom Order: ` + relevantTags);

    // Function to get the rank of a single tag
    const getTagRank = (tag) => {
      const index = relevantTags.findIndex((relevantTag) => relevantTag.toLowerCase() === tag.toLowerCase());
      return index !== -1 ? index : relevantTags.length; // If tag not found, place at the end
    };

    // Function to get the maximum rank of all tags in a post
    const getMaxTagRank = (postTags) => {
      return postTags.reduce((maxRank, tag) => {
        const rank = getTagRank(tag);
        return rank > maxRank ? rank : maxRank;
      }, -1);
    };

    // Sort the user posts using bubble sort based on the maximum rank of their individual tags
    const orderedData = bubbleSort(userPosts);

    const isValidDate = (dateStr) => {
      const regex = /^\d{1,2}-\d{1,2}-\d{4}$/;
      return regex.test(dateStr);
    };

    const toUTCPlus8 = (date) => {
      const utcTime = date.getTime();
      const utcPlus8Time = utcTime + 8 * 60 * 60 * 1000;
      return new Date(utcPlus8Time);
    };

    const filteredData = orderedData.filter((item) => {
      if (queryType === "topic" && query) {
        return item.postTags.some((tag) => tag.toLowerCase().startsWith(query.toLowerCase()));
      } else if (queryType === "title" && query) {
        return item.postTitle.toLowerCase().startsWith(query.toLowerCase());
      } else if (queryType === "description" && query) {
        return item.postDescription.toLowerCase().startsWith(query.toLowerCase());
      } else if (queryType === "date" && query) {
        if (!isValidDate(query)) {
          console.error("Invalid date format. Please use MM-DD-YYYY.");
          return false;
        }
        const [month, day, year] = query.split("-").map(Number);
        const searchDate = new Date(Date.UTC(year, month - 1, day));
        const searchDateUTCPlus8 = toUTCPlus8(searchDate);

        searchDateUTCPlus8.setHours(0, 0, 0, 0); // Set to the start of the day in UTC+8


        const itemDate = new Date(item.datePosted._seconds * 1000 + item.datePosted._nanoseconds / 1000000);
        const itemDateUTCPlus8 = toUTCPlus8(itemDate);

        itemDateUTCPlus8.setHours(0, 0, 0, 0); // Set to the start of the day in UTC+8

        return itemDateUTCPlus8.getTime() === searchDateUTCPlus8.getTime();
      } else {
        // No filter applied, return all items
        return true;
      }
    });

    res.json(filteredData);
  });
});

exports.getUsers = onRequest({
  region: "asia-southeast1",
}, async (req, res) => {
  // Grab the user type and email from the request
  cors(req, res, async () => {
    const userType = req.query.userType;
    const userEmail = req.query.email;
    const centerId = req.query.centerId;
    const query = req.query.query;
    const queryType = req.query.queryType;

    const type = userType && userType === "learner" ? "tutor" : "learner";

    const db = getFirestore();

    const users = db.collection("all_users")
        .doc(userType).collection("users");

    const allUsers = db.collection("all_users")
        .doc(centerId ? "tutor" : type).collection("users");

    const allReviews = db.collection("all_reviews")
        .doc("allReviews")
        .collection("reviewList");

    const userRef = await users.where("userEmail", "==", userEmail).get();
    const usersRef = centerId ? await allUsers.where(Filter.or(
        Filter.where("userTutoringcenter", "==", centerId),
        Filter.where("userTutoringCenter", "==", centerId),
    )).get() : await allUsers.get();
    const reviewsRef = await allReviews.get();

    const usersArr = [];
    const userData = [];
    const reviewsArr = [];

    // Iterate over reviewsRef to get review data.
    reviewsRef.forEach((doc) => {
      reviewsArr.push(doc.data());
    });

    // Iterate over userRef to get user data.
    userRef.forEach((doc) => {
      userData.push(doc.data());
    });

    const userTags = userData[0].userTags || userData[0].userTag || [];
    const tags = JSON.stringify(userTags);

    const getAverageRatings = (reviewsArr) => {
      const userRatings = {};

      reviewsArr.forEach((review) => {
        const email = review.revieweeEmail;

        if (!userRatings[email]) {
          userRatings[email] = {
            totalRating: 0,
            count: 0,
          };
        }

        userRatings[email].totalRating += review.userRating;
        userRatings[email].count += 1;
      });

      const averageRatings = [];

      // eslint-disable-next-line guard-for-in
      for (const email in userRatings) {
        const {totalRating, count} = userRatings[email];
        averageRatings.push({email, averageRating: totalRating / count});
      }

      return averageRatings;
    };

    const ratingsArr = getAverageRatings(reviewsArr);

    const ratingMap = new Map(ratingsArr.map((item) => [item.email, item.averageRating]));


    // Iterate over usersRef to get all users based on type.
    usersRef.forEach((doc) => {
      console.log(doc.id, "=>", doc.data());
      usersArr.push(doc.data());
    });

    if (usersArr.length === 0) {
      return res.json(usersArr);
    }

    // Function to get the rank of a single tag
    const getTagRank = (tag) => {
      const index = relevantTags.findIndex((relevantTag) => relevantTag.toLowerCase() === tag.toLowerCase());
      return index !== -1 ? index : relevantTags.length; // If tag not found, place at the end
    };

    // Function to get the maximum rank of all tags in a user
    const getMaxTagRank = (userTags) => {
      if (!userTags || userTags.length === 0) {
        return relevantTags.length; // If user has no tags, assign the highest rank value to place at the end
      }
      return userTags.reduce((maxRank, tag) => {
        const rank = getTagRank(tag);
        return rank > maxRank ? rank : maxRank;
      }, -1);
    };

    // Bubble sort function based on the maximum tag rank
    const bubbleSort = (array) => {
      const n = array.length;
      let swapped;
      do {
        swapped = false;
        for (let i = 0; i < n - 1; i++) {
          const tagsA = array[i].userTags || array[i].userTag || [];
          const tagsB = array[i + 1].userTags || array[i + 1].userTag || [];
          const maxRankA = getMaxTagRank(tagsA);
          const maxRankB = getMaxTagRank(tagsB);
          if (maxRankA > maxRankB) {
            const temp = array[i];
            array[i] = array[i + 1];
            array[i + 1] = temp;
            swapped = true;
          }
        }
      } while (swapped);
      return array;
    };

    // Get all unique tags
    const allUserTags = Array.from(new Set(usersArr.reduce((acc, item) => {
      if (item.userTags) {
        acc = acc.concat(item.userTags.map((tag) => tag.toLowerCase()));
      }
      if (item.userTag) {
        acc = acc.concat(item.userTag.map((tag) => tag.toLowerCase()));
      }
      return acc;
    }, [])));


    console.log(`User tags: ` + tags);
    console.log(`All tags: ` + allUserTags);

    usersArr.forEach((user) => {
      const email = user.userEmail;
      const rating = email ? ratingMap.get(email) : NaN;

      if (rating !== undefined && !isNaN(rating)) {
        user.userRating = rating;
      } else {
        user.userRating = 0;
      }
    });

    // Get new order of tags based on relevance
    const customOrder = await getRelevance(tags, allUserTags);

    // Parse the result as an array
    const relevantTags = JSON.parse(customOrder);

    console.log(`Custom Order: ` + relevantTags);

    const orderedData = bubbleSort(usersArr);

    const allCenters = db.collection("all_users")
        .doc("tutor_center").collection("users");

    const centersRef = await allCenters.get();

    const filteredData = orderedData.filter((item) => {
      if (queryType === "topic" && query) {
        return (item.userTags || item.userTag || []).some((tag) => tag.toLowerCase().startsWith(query.toLowerCase()));
      } else if (queryType === "firstName" && query) {
        return item.userFirstname.toLowerCase().startsWith(query.toLowerCase());
      } else if (queryType === "lastName" && query) {
        return item.userLastname.toLowerCase().startsWith(query.toLowerCase());
      } else if (queryType === "about" && query) {
        return (item.userabout || item.userAbout).toLowerCase().startsWith(query.toLowerCase());
      } else if (queryType === "tutorCenter" && query) {
        const centersArr = [];

        // Iterate over centersRef to get centers data.
        centersRef.forEach((doc) => {
          centersArr.push(doc.data());
        });

        const matchingCenter = centersArr.filter((item) => {
          return item.name.toLowerCase().startsWith(query.toLowerCase());
        });

        const centerIds = [];
        matchingCenter.forEach((center) => {
          centerIds.push(center.uuid);
        });


        return centerIds.includes(item.userTutoringCenter || item.userTutoringcenter);
      } else if (queryType === "price" && query) {
        // Ensure the query value is at least the userSessionPrice

        return item.userSessionPrice && parseFloat(item.userSessionPrice) <= parseFloat(query);
      } else {
        // No filter applied, return all items
        return true;
      }
    });

    res.json(filteredData);
  });
});

exports.getCenters = onRequest({
  region: "asia-southeast1",
}, async (req, res) => {
  // Grab the user type and email from the request
  cors(req, res, async () => {
    const query = req.query.query;
    const queryType = req.query.queryType;

    const db = getFirestore();

    const allTutors = db.collection("all_users")
        .doc("tutor").collection("users");

    const allReviews = db.collection("all_reviews")
        .doc("allReviews")
        .collection("reviewList");

    const tutorsRef = await allTutors.get();
    const reviewsRef = await allReviews.get();

    const tutorsArr = [];
    const reviewsArr = [];

    // Iterate over reviewsRef to get reviews data.
    reviewsRef.forEach((doc) => {
      reviewsArr.push(doc.data());
    });

    // Iterate over tutorsRef to get all tutors data.
    tutorsRef.forEach((doc) => {
      tutorsArr.push(doc.data());
    });

    const getAverageRatings = (reviewsArr) => {
      const userRatings = {};

      reviewsArr.forEach((review) => {
        const email = review.revieweeEmail;

        if (!userRatings[email]) {
          userRatings[email] = {
            totalRating: 0,
            count: 0,
          };
        }

        userRatings[email].totalRating += review.userRating;
        userRatings[email].count += 1;
      });

      const averageRatings = [];

      // eslint-disable-next-line guard-for-in
      for (const email in userRatings) {
        const {totalRating, count} = userRatings[email];
        averageRatings.push({email, averageRating: totalRating / count});
      }

      return averageRatings;
    };

    const ratingsArr = getAverageRatings(reviewsArr);

    const ratingMap = new Map(ratingsArr.map((item) => [item.email, item.averageRating]));

    tutorsArr.forEach((user) => {
      const email = user.userEmail;
      const rating = email ? ratingMap.get(email) : NaN;

      if (rating !== undefined && !isNaN(rating)) {
        user.userRating = rating;
      } else {
        user.userRating = 0;
      }
    });

    console.log(tutorsArr);

    const getCenterAverageRatings = (tutorsArr) => {
      const centerRatings = {};

      tutorsArr.forEach((tutor) => {
        const uuid = tutor.userTutoringcenter || tutor.userTutoringCenter;

        if (!centerRatings[uuid]) {
          centerRatings[uuid] = {
            totalRating: 0,
            count: 0,
            tutorsCount: 0,
          };
        }

        centerRatings[uuid].totalRating += tutor.userRating;
        if (tutor.userRating > 0) {
          centerRatings[uuid].count += 1;
        }
        centerRatings[uuid].tutorsCount += 1;
      });

      const averageRatings = [];

      // eslint-disable-next-line guard-for-in
      for (const uuid in centerRatings) {
        const {totalRating, count, tutorsCount} = centerRatings[uuid];

        averageRatings.push({uuid, averageRating: totalRating / count, tutorsCount});
      }

      return averageRatings;
    };

    const centersRatingsArr = getCenterAverageRatings(tutorsArr);
    console.log(ratingsArr);
    console.log(centersRatingsArr);

    const allCenters = db.collection("all_users")
        .doc("tutor_center").collection("users");


    const centersRef = await allCenters.get();

    const centersArr = [];

    // Iterate over centersRef to get centers data.
    centersRef.forEach((doc) => {
      centersArr.push(doc.data());
    });


    const centersRatingMap = new Map(centersRatingsArr.map((item) => [item.uuid, item.averageRating]));

    const centersCountMap = new Map(centersRatingsArr.map((item) => [item.uuid, item.tutorsCount]));

    centersArr.forEach((center) => {
      const uuid = center.uuid;
      const rating = uuid ? centersRatingMap.get(uuid) : NaN;
      const count = uuid ? centersCountMap.get(uuid) : NaN;

      if (rating !== undefined && !isNaN(rating)) {
        center.overallRating = rating;
      } else {
        center.overallRating = 0;
      }

      if (count !== undefined && !isNaN(count)) {
        center.numberOfTutors = count;
      } else {
        center.numberOfTutors = 0;
      }
    });

    const filteredData = centersArr.filter((item) => {
      if (queryType === "name" && query) {
        return item.name.toLowerCase().startsWith(query.toLowerCase());
      } else if (queryType === "rating" && query) {
        // Ensure the query value is at least the userSessionPrice

        return item.overallRating && parseFloat(item.overallRating) >= parseFloat(query);
      } else {
        // No filter applied, return all items
        return true;
      }
    });

    res.json(filteredData);
  });
});

exports.sendEmail = onRequest({
  region: "asia-southeast1",
}, async (req, res) => {
  cors(req, res, () => {
    // Retrieve email details from the request body
    const {to, subject, html} = req.body;

    if (!to || !subject || !html) {
      return res.status(400).send("Missing required fields");
    }

    // Setup email data
    const mailOptions = {
      from: `Matutor <${process.env.EMAIL_USER}>`,
      to: to,
      subject: subject,
      html: html,
    };

    // Send the email
    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        return res.status(500).send(error.toString());
      }
      return res.status(200).send("Email sent: " + info.response);
    });
  });
});

exports.sendNotif = onRequest({
  region: "asia-southeast1",
}, async (req, res) => {
  cors(req, res, async () => {
    const {email, userType, title, body} = req.body;

    if (!email | !userType | !title | !body) {
      return res.status(400).send("Missing required fields");
    }

    const db = getFirestore();

    const users = db.collection("all_users")
        .doc(userType).collection("users");

    const userRef = await users.where("userEmail", "==", email).get();

    const userData = [];

    // Iterate over userRef to get user data.
    userRef.forEach((doc) => {
      userData.push(doc.data());
    });

    const userToken = userData[0].fcmToken;

    if (!userToken) {
      return res.status(500).send("No token for user");
    }

    const message = {
      notification: {
        body: body,
        title: title,
      },
      token: userToken,
    };

    getMessaging().send(message)
        .then((response) => {
        // Response is a message ID string.
          console.log("Successfully sent message:", response);
          return res.status(200).send("Successfully sent message: " + response);
        })
        .catch((error) => {
          return res.status(500).send(error.toString());
        });
  });
});
