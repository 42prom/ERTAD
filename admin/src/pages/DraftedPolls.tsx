import { useState } from "react";
import { useAsyncResource } from "../components/useAsyncResource";
import { useNavigate } from "react-router-dom";
import { FileText, Edit, Trash2 } from "lucide-react";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import { adminPollsApi } from "../api/client";

const loadDrafts = () => adminPollsApi.list("draft");

export default function DraftedPolls() {
  const navigate = useNavigate();
  const [revision, setRevision] = useState(0);
  const { data, loading, failed } = useAsyncResource(
    String(revision),
    loadDrafts,
  );
  const polls = data ?? [];

  const handleDelete = async (pollId: string) => {
    if (!confirm("Are you sure you want to delete this draft?")) {
      return;
    }

    try {
      await adminPollsApi.delete(pollId);
      setRevision((v) => v + 1);
    } catch (error) {
      console.error("Failed to delete draft:", error);
      alert("Failed to delete draft");
    }
  };

  const handlePublish = async (pollId: string) => {
    if (!confirm("Are you sure you want to publish this poll?")) {
      return;
    }

    try {
      await adminPollsApi.publish(pollId);
      setRevision((v) => v + 1);
      alert("Poll published successfully");
    } catch (error) {
      console.error("Failed to publish poll:", error);
      alert("Failed to publish poll");
    }
  };

  if (failed)
    return (
      <Card>
        <p role="alert">
          Could not load polls. Check your access and try again.
        </p>
        <button onClick={() => setRevision((v) => v + 1)}>Retry</button>
      </Card>
    );
  if (loading) {
    return (
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Drafted Polls</h1>
          <p className="text-gray-600 mt-1">Manage your draft polls</p>
        </div>
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-32 bg-gray-200 rounded-lg animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Drafted Polls</h1>
        <p className="text-gray-600 mt-1">Manage your draft polls</p>
      </div>

      {polls.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-12">
          <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
            <FileText className="w-8 h-8 text-gray-400" />
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">
            No drafts found
          </h2>
          <p className="text-gray-600 text-center max-w-md">
            Your draft polls will appear here. Create a new poll to get started.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {polls.map((poll) => (
            <Card key={poll.id}>
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-gray-900">
                    {poll.title}
                  </h3>
                  {poll.description && (
                    <p className="text-sm text-gray-600 mt-1">
                      {poll.description}
                    </p>
                  )}
                  <div className="flex items-center gap-4 mt-3">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                      {poll.type}
                    </span>
                    <span className="text-sm text-gray-500">
                      {poll.options.length} options
                    </span>
                    <span className="text-sm text-gray-500">
                      Created {new Date(poll.created_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>
                <div className="flex gap-2 ml-4">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate(`/polls/${poll.id}/edit`)}
                  >
                    <Edit className="w-4 h-4 mr-1" />
                    Edit
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handlePublish(poll.id)}
                  >
                    Publish
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(poll.id)}
                  >
                    <Trash2 className="w-4 h-4 text-red-600" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
