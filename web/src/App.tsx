import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import { useEffect, useState } from "react";
import { getMe, type User } from "./api.ts";
import ChatPage from "./ChatPage.tsx";
import LoginPage from "./LoginPage.tsx";

/** Shows the login screen or the chat, depending on whether there's a valid session */
export default function App() {
  // undefined while checking the session on load, null when logged out
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    getMe()
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) {
    return (
      <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <CircularProgress />
      </Box>
    );
  }
  return user ? <ChatPage user={user} onLoggedOut={() => setUser(null)} /> : <LoginPage onLoggedIn={setUser} />;
}
