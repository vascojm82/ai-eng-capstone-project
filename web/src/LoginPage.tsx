import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import Alert from "@mui/material/Alert";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useState, type FormEvent } from "react";
import { login, type User } from "./api.ts";

export default function LoginPage({ onLoggedIn }: { onLoggedIn: (user: User) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      onLoggedIn(await login(username.trim(), password));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed. Please try again.");
      setLoading(false);
    }
  }

  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        px: 2,
        background: "linear-gradient(160deg, #F3F3F3 0%, #E4E4E4 100%)",
      }}
    >
      <Card elevation={3} sx={{ width: "100%", maxWidth: 400 }}>
        <CardContent sx={{ p: 4 }}>
          <Stack component="form" onSubmit={submit} spacing={2.5}>
            <Stack spacing={1} sx={{ alignItems: "center" }}>
              <Avatar sx={{ bgcolor: "common.black", width: 56, height: 56 }}>
                <DirectionsCarIcon fontSize="large" />
              </Avatar>
              <Typography variant="h5">Service Assistant</Typography>
              <Typography variant="body2" color="text.secondary" align="center">
                Answers from Acura owner's and navigation manuals, model years 2022–2026
              </Typography>
            </Stack>

            {error && <Alert severity="error">{error}</Alert>}

            <TextField
              label="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
              fullWidth
            />
            <TextField
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              fullWidth
            />
            <Button type="submit" variant="contained" size="large" disabled={loading || !username || !password}>
              {loading ? <CircularProgress size={24} color="inherit" /> : "Log in"}
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
