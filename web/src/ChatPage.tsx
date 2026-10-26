import AddCommentOutlinedIcon from "@mui/icons-material/AddCommentOutlined";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import LogoutIcon from "@mui/icons-material/Logout";
import PersonOutlinedIcon from "@mui/icons-material/PersonOutlined";
import PictureAsPdfOutlinedIcon from "@mui/icons-material/PictureAsPdfOutlined";
import SendIcon from "@mui/icons-material/Send";
import Alert from "@mui/material/Alert";
import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Container from "@mui/material/Container";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import { ApiError, logout, sendChat, type Source, type User } from "./api.ts";

type Message = { role: "user" | "assistant"; content: string; sources?: Source[] };

const EXAMPLES = [
  "What tire pressure should I use on my 2026 MDX?",
  "How do I pair my phone with my 2024 ZDX?",
  "How much oil does the 3.0 L engine in a 2026 MDX take?",
  "How do I clear my recent destinations in my 2026 RDX navigation?",
];

// The conversation is kept in the browser per user, so a page refresh doesn't lose it
const storageKey = (user: User) => `chat:${user.username}`;
function loadConversation(user: User): Message[] {
  try {
    return JSON.parse(localStorage.getItem(storageKey(user)) ?? "[]");
  } catch {
    return [];
  }
}
function saveConversation(user: User, messages: Message[]) {
  try {
    localStorage.setItem(storageKey(user), JSON.stringify(messages));
  } catch {
    // storage unavailable (private mode, full): the chat still works, it just won't survive a refresh
  }
}

export default function ChatPage({ user, onLoggedOut }: { user: User; onLoggedOut: () => void }) {
  const [messages, setMessages] = useState<Message[]>(() => loadConversation(user));
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  // Block bodies on purpose: an effect must return nothing or a cleanup function, and
  // scrollIntoView returns a Promise in recent browsers, which React would try to call
  useEffect(() => {
    saveConversation(user, messages);
  }, [user, messages]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || loading) return;
    const conversation: Message[] = [...messages, { role: "user", content: question }];
    setMessages(conversation);
    setInput("");
    setError(null);
    setLoading(true);
    try {
      const { reply, sources } = await sendChat(conversation.map(({ role, content }) => ({ role, content })));
      setMessages([...conversation, { role: "assistant", content: reply, sources }]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onLoggedOut();
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send(input);
    }
  }

  async function handleLogout() {
    await logout().catch(() => {});
    onLoggedOut();
  }

  return (
    <Box sx={{ height: "100vh", display: "flex", flexDirection: "column", bgcolor: "background.default" }}>
      <AppBar position="static" elevation={0}>
        <Toolbar sx={{ gap: 1 }}>
          <DirectionsCarIcon />
          <Typography variant="h6" noWrap sx={{ flexGrow: 1, fontWeight: 600, fontSize: { xs: "1.1rem", sm: "1.25rem" } }}>
            Service Assistant
          </Typography>
          <Chip
            icon={<PersonOutlinedIcon />}
            label={user.username}
            size="small"
            sx={{
              display: { xs: "none", sm: "inline-flex" },
              bgcolor: "rgba(255,255,255,0.15)",
              color: "inherit",
              "& .MuiChip-icon": { color: "inherit" },
            }}
          />
          <Tooltip title="New conversation">
            <span>
              <IconButton color="inherit" onClick={() => setMessages([])} disabled={loading || messages.length === 0}>
                <AddCommentOutlinedIcon />
              </IconButton>
            </span>
          </Tooltip>
          <Button
            color="inherit"
            startIcon={<LogoutIcon />}
            onClick={handleLogout}
            sx={{ display: { xs: "none", sm: "inline-flex" } }}
          >
            Log out
          </Button>
          <Tooltip title="Log out">
            <IconButton color="inherit" onClick={handleLogout} sx={{ display: { xs: "inline-flex", sm: "none" } }}>
              <LogoutIcon />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>

      <Box sx={{ flexGrow: 1, overflowY: "auto" }}>
        <Container maxWidth="md" sx={{ py: 3 }}>
          {messages.length === 0 && !loading ? (
            <Stack spacing={2} sx={{ mt: 8, alignItems: "center", textAlign: "center" }}>
              <Typography variant="h5">How can I help with your Acura?</Typography>
              <Typography color="text.secondary">
                Ask about features, maintenance or specifications. Include your car's year and model, like "my 2026 MDX".
              </Typography>
              <Stack direction="row" sx={{ pt: 1, flexWrap: "wrap", justifyContent: "center", gap: 1 }}>
                {EXAMPLES.map((example) => (
                  <Chip key={example} label={example} variant="outlined" clickable onClick={() => send(example)} />
                ))}
              </Stack>
            </Stack>
          ) : (
            <Stack spacing={2}>
              {messages.map((message, i) => (
                <MessageBubble key={i} message={message} />
              ))}
              {loading && (
                <Paper variant="outlined" sx={{ p: 2, alignSelf: "flex-start", display: "flex", gap: 1.5, alignItems: "center" }}>
                  <CircularProgress size={18} />
                  <Typography variant="body2" color="text.secondary">
                    Searching the manuals…
                  </Typography>
                </Paper>
              )}
              {error && <Alert severity="warning">{error}</Alert>}
            </Stack>
          )}
          <div ref={bottom} />
        </Container>
      </Box>

      <Paper square elevation={6} sx={{ py: 2 }}>
        <Container maxWidth="md">
          <Stack direction="row" spacing={1} sx={{ alignItems: "flex-end" }}>
            <TextField
              placeholder="Ask about your Acura…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              multiline
              maxRows={4}
              fullWidth
              size="small"
              slotProps={{ htmlInput: { maxLength: 4000 } }}
            />
            <IconButton color="primary" onClick={() => send(input)} disabled={loading || !input.trim()} aria-label="Send">
              <SendIcon />
            </IconButton>
          </Stack>
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1, textAlign: "center" }}>
            Enter to send, Shift+Enter for a new line. Unofficial assistant: answers come from Acura's published manuals;
            for anything about your specific car, check with an Acura dealer.
          </Typography>
        </Container>
      </Paper>
    </Box>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <Paper
      elevation={isUser ? 0 : 1}
      sx={{
        p: 2,
        maxWidth: "85%",
        alignSelf: isUser ? "flex-end" : "flex-start",
        // Your messages in charcoal like acura.com's dark sections; red stays for buttons
        bgcolor: isUser ? "secondary.main" : "background.paper",
        color: isUser ? "secondary.contrastText" : "text.primary",
      }}
    >
      {isUser ? (
        <Typography sx={{ whiteSpace: "pre-wrap" }}>{message.content}</Typography>
      ) : (
        <Box
          sx={{
            typography: "body1",
            "& p": { m: 0, mb: 1 },
            "& p:last-child": { mb: 0 },
            "& ol, & ul": { pl: 3, my: 0.5 },
            "& li": { mb: 0.5 },
          }}
        >
          <Markdown>{message.content}</Markdown>
        </Box>
      )}
      {!!message.sources?.length && (
        <Stack direction="row" sx={{ mt: 1.5, flexWrap: "wrap", gap: 1 }}>
          {message.sources.map((source) => (
            <Chip
              key={`${source.docCode}-${source.page}`}
              icon={<PictureAsPdfOutlinedIcon />}
              label={`${source.manual} · p. ${source.page}`}
              title={source.section ?? undefined}
              size="small"
              variant="outlined"
              component="a"
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              clickable
            />
          ))}
        </Stack>
      )}
    </Paper>
  );
}
