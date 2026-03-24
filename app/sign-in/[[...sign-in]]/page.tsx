import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-black px-4">
      <div className="flex flex-col items-center w-full max-w-md -mt-16">
        <div className="text-center mb-5">
          <h1 className="text-4xl font-bold text-white mb-2">Welcome back</h1>
          <p className="text-gray-400">Sign in to continue to Clipify</p>
        </div>
        <SignIn
        appearance={{
          elements: {
            rootBox: "w-full max-w-md",
            card: "bg-gray-900 border border-gray-800 shadow-2xl rounded-2xl w-full",
            headerTitle: "hidden",
            headerSubtitle: "hidden",
            socialButtonsBlockButton:
              "bg-gray-800 border border-gray-700 text-gray-200 hover:bg-gray-700 hover:text-white transition-colors",
            socialButtonsBlockButtonText: "text-gray-200 font-medium",
            formFieldLabel: "text-gray-300 font-medium",
            formFieldInput:
              "bg-gray-800 border-gray-700 text-white placeholder:text-gray-500 focus:border-purple-500 focus:ring-purple-500",
            formButtonPrimary:
              "bg-purple-600 hover:bg-purple-500 text-white font-semibold shadow-lg transition-colors",
            footerActionLink:
              "text-purple-400 hover:text-purple-300 font-medium",
            dividerLine: "bg-gray-700",
            dividerText: "text-gray-500",
            formFieldErrorText: "text-red-400",
            identityPreviewEditButton: "text-purple-400 hover:text-purple-300",
            alert: "bg-red-900/30 border border-red-800 text-red-300",
          },
        }}
        />
      </div>
    </div>
  );
}
