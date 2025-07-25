const express = require("express");
const mysql = require("mysql2");
const session = require("express-session");
const flash = require("connect-flash");
const multer = require("multer");
require("dotenv").config();

const app = express();

const storage = multer.diskStorage({
	destination: (req, file, cb) => {
		cb(null, "public/images");
	},
	filename: (req, file, cb) => {
		cb(null, file.originalname);
	},
});

const upload = multer({ storage: storage });

// Database connection
const db = mysql.createConnection({
	host: process.env.DB_HOST,
	user: process.env.DB_USERNAME,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
});

db.connect((err) => {
	if (err) {
		console.error("Error connection to MySQL:", err);
		return;
	}
	console.log("Connected to MySQL database");
});

app.use(express.urlencoded({ extended: false }));
app.use(express.static("public"));

//functions
function checkFavoriteOwnershipOrAdmin(req, res, next) {
	const favoriteId = req.params.id;
	const userId = req.session.user.id;
	const isAdmin = req.session.user.isAdmin;

	const sql = "SELECT * FROM favorites WHERE id = ?";
	db.query(sql, [favoriteId], (err, results) => {
		if (err) return res.status(500).send("Database error");
		if (!results.length) return res.status(404).send("Favorite not found");

		const favorite = results[0];
		if (favorite.user_id === userId || isAdmin) {
			next();
		} else {
			return res.status(403).send("Unauthorized");
		}
	});
}

// Session Middleware
app.use(
	session({
		secret: process.env.SESSION_SECRET || "hawker-hero-secret",
		resave: false,
		saveUninitialized: true,
		cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }, // 7 days
	})
);

app.use(flash());
app.set("view engine", "ejs");

// Helper function to promisify db.query
// IMPORTANT: This needs to be defined BEFORE it's used in your routes.
const queryDB = (sql, params = []) => {
	return new Promise((resolve, reject) => {
		db.query(sql, params, (err, results) => {
			if (err) {
				return reject(err);
			}
			resolve(results);
		});
	});
};

// Middleware to check if user is logged in
const checkAuthenticated = (req, res, next) => {
	if (req.session.user) {
		return next();
	} else {
		req.flash("error", "Please log in to view this resource.");
		return res.redirect("/login");
	}
};

// Middleware to check if user is admin
const checkAdmin = (req, res, next) => {
	if (req.session.user && req.session.user.role === "admin") {
		return next();
	} else {
		req.flash("error", "You do not have permission to view this resource.");
		return res.redirect("/");
	}
};

// Validation middleware for registration
const validateRegistration = (req, res, next) => {
	const { username, email, password } = req.body;

	if (!username || !email || !password) {
		req.flash("error", "All fields are required.");
		req.flash("formData", req.body);
		return res.redirect("/register");
	}

	if (password.length < 6) {
		req.flash("error", "Password must be at least 6 characters long.");
		req.flash("formData", req.body);
		return res.redirect("/register");
	}

	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	if (!emailRegex.test(email)) {
		req.flash("error", "Please enter a valid email address.");
		req.flash("formData", req.body);
		return res.redirect("/register");
	}

	next();
};

// Routes
app.get("/", (req, res) => {
	res.render("index", {
		title: "Hawker Hero - Home",
		user: req.session.user,
		messages: req.flash("success"),
	});
});

app.get("/register", (req, res) => {
	res.render("auth/register", {
		title: "Register - Hawker Hero",
		messages: req.flash("error"),
		formData: req.flash("formData")[0],
	});
});

app.post("/register", validateRegistration, (req, res) => {
	const { username, email, password, role } = req.body;

	const checkUserSql = "SELECT * FROM users WHERE email = ? OR username = ?";
	db.query(checkUserSql, [email, username], (err, results) => {
		if (err) {
			console.error("Database error:", err);
			req.flash("error", "Registration failed. Please try again.");
			return res.redirect("/register");
		}

		if (results.length > 0) {
			req.flash("error", "Username or email already exists.");
			req.flash("formData", req.body);
			return res.redirect("/register");
		}

		const insertSql =
			"INSERT INTO users (username, email, password_hash, role, created_at) VALUES (?, ?, SHA1(?), ?, NOW())";
		const userRole = role || "user";

		db.query(
			insertSql,
			[username, email, password, userRole],
			(err, result) => {
				if (err) {
					console.error("Database error:", err);
					req.flash("error", "Registration failed. Please try again.");
					return res.redirect("/register");
				}
				req.flash("success", "Registration successful! Please log in.");
				res.redirect("/login");
			}
		);
	});
});

app.get("/login", (req, res) => {
	res.render("auth/login", {
		title: "Login - Hawker Hero",
		messages: req.flash("success"),
		errors: req.flash("error"),
	});
});

app.post("/login", (req, res) => {
	const { email, password } = req.body;

	if (!email || !password) {
		req.flash("error", "Email and password are required.");
		return res.redirect("/login");
	}

	const sql = "SELECT * FROM users WHERE email = ? AND password_hash = SHA1(?)";
	db.query(sql, [email, password], (err, results) => {
		if (err) {
			console.error("Database error:", err);
			req.flash("error", "Login failed. Please try again.");
			return res.redirect("/login");
		}

		if (results.length > 0) {
			req.session.user = results[0];
			req.flash("success", "Login successful!");
			return res.redirect("/dashboard");
		} else {
			req.flash("error", "Invalid email or password.");
			return res.redirect("/login");
		}
	});
});

app.get("/dashboard", checkAuthenticated, (req, res) => {
	res.render("dashboard", {
		title: "Dashboard - Hawker Hero",
		user: req.session.user,
		messages: req.flash("success"),
		errors: req.flash("error"),
	});
});

app.get("/admin", checkAuthenticated, checkAdmin, (req, res) => {
	res.render("admin/dashboard", {
		title: "Admin Dashboard - Hawker Hero",
		user: req.session.user,
		messages: req.flash("success"),
		stats: { users: 0, hawker_centers: 0, stalls: 0, reviews: 0 },
	});
});

// Admin: Manage Favorites
app.get("/admin/manage-favorites", checkAuthenticated, checkAdmin, async (req, res) => {
  try {
    const favorites = await queryDB(`
      SELECT f.id, f.notes, f.created_at,
             u.username,
             s.name AS stall_name,
             fd.name AS food_name
      FROM favorites f
      JOIN users u ON f.user_id = u.id
      LEFT JOIN stalls s ON f.stall_id = s.id
      LEFT JOIN food_items fd ON f.food_id = fd.id
      ORDER BY f.created_at DESC
    `);

    res.render("admin/manage-favorites", {
      title: "Manage Favorites - Admin",
      user: req.session.user,
      favorites,
      messages: req.flash("success"),
      errors: req.flash("error"),
    });
  } catch (err) {
    console.error("Database error fetching favorites:", err);
    req.flash("error", "Failed to load favorites.");
    res.render("admin/manage-favorites", {
      title: "Manage Favorites - Admin",
      user: req.session.user,
      favorites: [],
      messages: req.flash("success"),
      errors: req.flash("error"),
    });
  }
});
// Admin: Edit Favorites
app.get("/admin/edit-favorites/:id", checkAuthenticated, checkAdmin, async (req, res) => {
  try {
    const [favorite] = await queryDB(
      `SELECT f.*, s.name AS stall_name, fd.name AS food_name
       FROM favorites f
       LEFT JOIN stalls s ON f.stall_id = s.id
       LEFT JOIN food_items fd ON f.food_id = fd.id
       WHERE f.id = ?`, [req.params.id]
    );
    if (!favorite) {
      req.flash("error", "Favorite not found.");
      return res.redirect("/admin/manage-favorites");
    }
    res.render("admin/edit-favorites", {
      title: "Edit Favorite - Admin",
      user: req.session.user,
      favorite
    });
  } catch (err) {
    req.flash("error", "Database error.");
    res.redirect("/admin/manage-favorites");
  }
});

app.post("/admin/edit-favorites/:id", checkAuthenticated, checkAdmin, async (req, res) => {
  const { stall_id, food_id, notes } = req.body;
  try {
    await queryDB(
      `UPDATE favorites SET stall_id = ?, food_id = ?, notes = ? WHERE id = ?`,
      [stall_id || null, food_id || null, notes, req.params.id]
    );
    req.flash("success", "Favorite updated successfully.");
    res.redirect("/admin/manage-favorites");
  } catch (err) {
    req.flash("error", "Failed to update favorite.");
    res.redirect("/admin/edit-favorites/" + req.params.id);
  }
});

// List user favorites  with pagination
app.get("/favorites", checkAuthenticated, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 9;
  const offset = (page - 1) * limit;
  const search = req.query.search ? `%${req.query.search}%` : null;

  try {
    let totalQuery, dataQuery, countParams, dataParams;

    if (search) {
      // If search is active
      totalQuery = `
        SELECT COUNT(*) AS total
        FROM favorites f
        LEFT JOIN stalls s ON f.stall_id = s.id
        LEFT JOIN food_items fd ON f.food_id = fd.id
        WHERE f.user_id = ? AND (s.name LIKE ? OR fd.name LIKE ?)
      `;

      dataQuery = `
        SELECT f.*, s.name AS stall_name, fd.name AS food_name
        FROM favorites f
        LEFT JOIN stalls s ON f.stall_id = s.id
        LEFT JOIN food_items fd ON f.food_id = fd.id
        WHERE f.user_id = ? AND (s.name LIKE ? OR fd.name LIKE ?)
        ORDER BY f.created_at DESC
        LIMIT ? OFFSET ?
      `;

      countParams = [req.session.user.id, search, search];
      dataParams = [req.session.user.id, search, search, limit, offset];
    } else {
      // No search term
      totalQuery = `
        SELECT COUNT(*) AS total
        FROM favorites
        WHERE user_id = ?
      `;

      dataQuery = `
        SELECT f.*, s.name AS stall_name, fd.name AS food_name
        FROM favorites f
        LEFT JOIN stalls s ON f.stall_id = s.id
        LEFT JOIN food_items fd ON f.food_id = fd.id
        WHERE f.user_id = ?
        ORDER BY f.created_at DESC
        LIMIT ? OFFSET ?
      `;

      countParams = [req.session.user.id];
      dataParams = [req.session.user.id, limit, offset];
    }

    const [{ total }] = await queryDB(totalQuery, countParams);
    const favorites = await queryDB(dataQuery, dataParams);
    const totalPages = Math.ceil(total / limit);

    res.render("favorites", {
      title: "My Favorites",
      user: req.session.user,
      favorites,
      messages: req.flash("success"),
      errors: req.flash("error"),
      currentPage: page,
      totalPages,
      search: req.query.search || ""
    });
  } catch (err) {
    console.error("Error loading favorites:", err);
    req.flash("error", "Failed to load favorites.");
    res.render("favorites", {
      title: "My Favorites",
      user: req.session.user,
      favorites: [],
      messages: req.flash("success"),
      errors: req.flash("error"),
      currentPage: 1,
      totalPages: 1,
      search: req.query.search || ""
    });
  }
});


// Show all users' favorites
app.get("/favorites/others", checkAuthenticated, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 9;
  const offset = (page - 1) * limit;

  try {
    const [{ total }] = await queryDB(
      `SELECT COUNT(*) AS total FROM favorites WHERE user_id != ?`, [req.session.user.id]
    );
    const favorites = await queryDB(
      `SELECT f.*, u.username, s.name AS stall_name, fd.name AS food_name
       FROM favorites f
       JOIN users u ON f.user_id = u.id
       LEFT JOIN stalls s ON f.stall_id = s.id
       LEFT JOIN food_items fd ON f.food_id = fd.id
       WHERE f.user_id != ?
       ORDER BY f.created_at DESC
       LIMIT ? OFFSET ?`,
      [req.session.user.id, limit, offset]
    );
    const totalPages = Math.ceil(total / limit);

    res.render("users-favorites", {
      title: "Other Users' Favorites",
      user: req.session.user,
      favorites,
      messages: req.flash("success"),
      errors: req.flash("error"),
      currentPage: page,
      totalPages
    });
  } catch (err) {
    req.flash("error", "Failed to load others' favorites.");
    res.render("users-favorites", {
      title: "Other Users' Favorites",
      user: req.session.user,
      favorites: [],
      messages: req.flash("success"),
      errors: req.flash("error"),
      currentPage: 1,
      totalPages: 1
    });
  }
});


// Add favorite (GET)
app.get("/favorites/add", checkAuthenticated, async (req, res) => {
  try {
    const stalls = await queryDB(`
      SELECT s.id, s.name, hc.name AS center_name
      FROM stalls s
      LEFT JOIN hawker_centers hc ON s.center_id = hc.id
      ORDER BY s.name ASC
    `);
    const foodItems = await queryDB(`
      SELECT fi.id, fi.name, fi.stall_id
      FROM food_items fi
      ORDER BY fi.name ASC
    `);
    res.render("addfavorites", {
      title: "Add Favorite",
      user: req.session.user,
      stalls,
      foodItems,
      messages: req.flash("success"),
      errors: req.flash("error"),
    });
  } catch (err) {
    req.flash("error", "Failed to load add favorite form.");
    res.redirect("/favorites");
  }
});
// Add favorite (POST)
app.post("/favorites/add", checkAuthenticated, (req, res) => {
  const { stall_id, food_id, notes } = req.body;
  const user_id = req.session.user.id;

  const checkSql = "SELECT * FROM favorites WHERE user_id = ? AND stall_id = ? AND food_id = ?";
  db.query(checkSql, [user_id, stall_id, food_id], (err, results) => {
    if (err) return res.status(500).send("Database error");
    if (results.length > 0) {
      req.flash("success", "Already in favorites!");
      return res.redirect("/favorites");
    }

    const insertSql = `
      INSERT INTO favorites (user_id, stall_id, food_id, notes, created_at)
      VALUES (?, ?, ?, ?, NOW())
    `;
    db.query(insertSql, [user_id, stall_id || null, food_id || null, notes || null], (err) => {
      if (err) return res.status(500).send("Database error");
      req.flash("success", "Added to favorites!");
      res.redirect("/favorites");
    });
  });
});

// Edit favorite form (GET)
app.get("/favorites/edit/:id", checkAuthenticated, async (req, res) => {
  try {
    const [favorite] = await queryDB(
      `SELECT f.*, s.name AS stall_name, fd.name AS food_name
       FROM favorites f
       LEFT JOIN stalls s ON f.stall_id = s.id
       LEFT JOIN food_items fd ON f.food_id = fd.id
       WHERE f.id = ? AND f.user_id = ?`, [req.params.id, req.session.user.id]
    );
    if (!favorite) {
      req.flash("error", "Favorite not found or not yours.");
      return res.redirect("/favorites");
    }
    const stalls = await queryDB(`SELECT id, name FROM stalls ORDER BY name ASC`);
    const foodItems = await queryDB(`SELECT id, name FROM food_items ORDER BY name ASC`);
    res.render("editfavorites", {
      title: "Edit Favorite",
      user: req.session.user,
      favorite,
      stalls,
      foodItems,
	  messages: req.flash("success"),
      errors: req.flash("error"),
    });
  } catch (err) {
    req.flash("error", "Database error.");
    res.redirect("/favorites");
  }
});

// Edit favorite submit (POST)()
app.post("/favorites/edit/:id", checkAuthenticated, async (req, res) => {
  const { stall_id, food_id, notes } = req.body;
  try {
    // Only update if the favorite belongs to the user
    await queryDB(
      `UPDATE favorites SET stall_id = ?, food_id = ?, notes = ? WHERE id = ? AND user_id = ?`,
      [stall_id || null, food_id || null, notes, req.params.id, req.session.user.id]
    );
    req.flash("success", "Favorite updated.");
    res.redirect("/favorites");
  } catch (err) {
    req.flash("error", "Failed to update favorite.");
    res.redirect("/favorites/edit/" + req.params.id);
  }
});

// Delete favorite
app.get("/favorites/delete/:id", checkAuthenticated, async (req, res) => {
  try {
    // Only delete if the favorite belongs to the user
    await queryDB(
      `DELETE FROM favorites WHERE id = ? AND user_id = ?`,
      [req.params.id, req.session.user.id]
    );
    req.flash("success", "Favorite deleted.");
  } catch (err) {
    req.flash("error", "Failed to delete favorite.");
  }
  res.redirect("/favorites");
});

app.get("/stalls", (req, res) => {
	res.render("stalls", {
		title: "Stalls - Hawker Hero",
		user: req.session.user,
		messages: req.flash("success"),
		stalls: [],
	});
});

app.get("/hawker-centers", (req, res) => {
	res.render("hawker-centers", {
		title: "Hawker Centers - Hawker Hero",
		user: req.session.user,
		messages: req.flash("success"),
		centers: [],
	});
});

app.get("/reviews", (req, res) => {
	res.render("reviews", {
		title: "Reviews - Hawker Hero",
		user: req.session.user,
		messages: req.flash("success"),
		reviews: [],
	});
});

app.get("/food-items", (req, res) => {
	res.render("food-items", {
		title: "Food Items - Hawker Hero",
		user: req.session.user,
		messages: req.flash("success"),
		foodItems: [],
	});
});

// ... (rest of your existing app.js code up to the recommendations routes)

// Recommendations Routes
app.get("/recommendations", async (req, res) => {
	// Get filter values from the query string
	const { search, stall, user } = req.query;
	const filters = {
		search: search || "",
		stall: stall || "",
		user: user || "",
	};

	// Base SQL query
	let sql = `
    SELECT r.*, u.username, s.name as stall_name,
           fi.name as food_name, hc.name as center_name
    FROM recommendations r
    JOIN users u ON r.user_id = u.id
    JOIN stalls s ON r.stall_id = s.id
    LEFT JOIN food_items fi ON r.food_id = fi.id
    LEFT JOIN hawker_centers hc ON s.center_id = hc.id
  `;

	// Dynamically build WHERE clause to prevent SQL injection
	const whereClauses = [];
	const params = [];

	if (search) {
		whereClauses.push("(r.tip LIKE ? OR s.name LIKE ? OR u.username LIKE ?)");
		params.push(`%${search}%`, `%${search}%`, `%${search}%`);
	}
	if (stall) {
		whereClauses.push("r.stall_id = ?");
		params.push(stall);
	}
	if (user) {
		whereClauses.push("r.user_id = ?");
		params.push(user);
	}

	if (whereClauses.length > 0) {
		sql += ` WHERE ${whereClauses.join(" AND ")}`;
	}

	sql += " ORDER BY r.created_at DESC LIMIT 50";

	try {
		// Fetch all necessary data concurrently
		const [recommendations, stalls, foodItems, recommendationUsers] =
			await Promise.all([
				queryDB(sql, params), // Use the dynamically built query
				queryDB(`
        SELECT s.id, s.name, hc.name as center_name
        FROM stalls s
        LEFT JOIN hawker_centers hc ON s.center_id = hc.id
        ORDER BY s.name ASC
      `),
				queryDB(`
        SELECT fi.id, fi.name, s.name as stall_name
        FROM food_items fi
        JOIN stalls s ON fi.stall_id = s.id
        ORDER BY fi.name ASC
      `),
				// Get only users who have made recommendations for the filter dropdown
				queryDB(`
        SELECT DISTINCT u.id, u.username
        FROM recommendations r
        JOIN users u ON r.user_id = u.id
        ORDER BY u.username ASC
      `),
			]);

		res.render("recommendations", {
			title: "Recommendations - Hawker Hero",
			user: req.session.user,
			messages: req.flash("success"),
			errors: req.flash("error"),
			recommendations: recommendations,
			stalls: stalls,
			foodItems: foodItems,
			recommendationUsers: recommendationUsers, // Pass users for the dropdown
			filters: filters, // Pass current filters back to the view
		});
	} catch (err) {
		console.error("Database error fetching recommendations page data:", err);
		req.flash("error", "Failed to load recommendations and related data.");
		res.render("recommendations", {
			title: "Recommendations - Hawker Hero",
			user: req.session.user,
			messages: req.flash("success"),
			errors: req.flash("error"),
			recommendations: [],
			stalls: [],
			foodItems: [],
			recommendationUsers: [],
			filters: filters,
		});
	}
});

// Route to handle adding a new recommendation (Admin Only)
app.post(
	"/recommendations/add",
	checkAuthenticated,
	checkAdmin,
	async (req, res) => {
		const { stall_id, food_id, tip } = req.body;
		const user_id = req.session.user.id; // Admin's user ID

		if (!stall_id || !tip) {
			req.flash("error", "Stall and Tip are required to add a recommendation.");
			return res.redirect("/recommendations");
		}

		try {
			const insertSql =
				"INSERT INTO recommendations (user_id, stall_id, food_id, tip, created_at) VALUES (?, ?, ?, ?, NOW())";
			// Convert food_id to null if it's an empty string
			const actualFoodId = food_id === "" ? null : food_id;
			await queryDB(insertSql, [user_id, stall_id, actualFoodId, tip]);

			req.flash("success", "Recommendation added successfully!");
			res.redirect("/recommendations");
		} catch (err) {
			console.error("Database error adding recommendation:", err);
			req.flash("error", "Failed to add recommendation. Please try again.");
			res.redirect("/recommendations");
		}
	}
);

// Route to handle updating a recommendation (Admin Only)
app.post(
	"/recommendations/edit/:id",
	checkAuthenticated,
	checkAdmin,
	async (req, res) => {
		const { id } = req.params;
		const { stall_id, food_id, tip } = req.body;

		if (!stall_id || !tip) {
			req.flash(
				"error",
				"Stall and Tip are required to update a recommendation."
			);
			return res.redirect("/recommendations");
		}

		try {
			const updateSql =
				"UPDATE recommendations SET stall_id = ?, food_id = ?, tip = ? WHERE id = ?";
			const actualFoodId = food_id === "" ? null : food_id;
			await queryDB(updateSql, [stall_id, actualFoodId, tip, id]);

			req.flash("success", `Recommendation ID ${id} updated successfully!`);
			res.redirect("/recommendations");
		} catch (err) {
			console.error("Database error updating recommendation:", err);
			req.flash("error", "Failed to update recommendation. Please try again.");
			res.redirect("/recommendations");
		}
	}
);

// Route to handle deleting a recommendation (Admin Only)
app.post(
	"/recommendations/delete/:id",
	checkAuthenticated,
	checkAdmin,
	async (req, res) => {
		const { id } = req.params;

		try {
			const deleteSql = "DELETE FROM recommendations WHERE id = ?";
			await queryDB(deleteSql, [id]);

			req.flash("success", `Recommendation ID ${id} deleted successfully!`);
			res.redirect("/recommendations");
		} catch (err) {
			console.error("Database error deleting recommendation:", err);
			req.flash("error", "Failed to delete recommendation. Please try again.");
			res.redirect("/recommendations");
		}
	}
);

app.get("/logout", (req, res) => {
	req.session.destroy((err) => {
		if (err) {
			console.error("Logout error:", err);
			// Optionally, you might flash an error message here if destroy fails
			req.flash("error", "Could not log out. Please try again.");
			return res.redirect("/dashboard"); // Or wherever they were
		}
		// Redirect to the homepage after successful logout
		res.redirect("/");
	});
});

app.listen(process.env.PORT || 3000, () => {
	console.log(
		`Server is running on http://localhost:${process.env.PORT || 3000}`
	);
});
